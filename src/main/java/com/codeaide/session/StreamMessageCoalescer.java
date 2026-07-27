package com.codeaide.session;

import com.codeaide.handler.core.HandlerContext;
import com.codeaide.util.JsUtils;
import com.codeaide.util.MessageJsonConverter;
import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.diagnostic.Logger;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.util.Alarm;

import java.util.ArrayList;
import java.util.List;
import java.util.function.LongConsumer;

/**
 * Coalesces streaming message updates to throttle webview pushes.
 * Batches rapid onMessageUpdate callbacks into periodic UI refreshes
 * to avoid overwhelming the JCEF browser.
 */
public class StreamMessageCoalescer {

    private static final Logger LOG = Logger.getInstance(StreamMessageCoalescer.class);
    private static final int UPDATE_INTERVAL_MS = 50;
    private static final int LARGE_UPDATE_PAYLOAD_CHARS = 150_000;
    private static final long SLOW_PAYLOAD_BUILD_MS = 25L;

    // During streaming, structural message changes (tool_use, tool_result,
    // thinking blocks) flow through the incremental upsertMessage channel:
    // each push carries only the messages mutated in that window (KB-scale),
    // instead of re-serializing and re-transmitting the full conversation.
    // This is what definitively killed the JCEF IPC death spiral — the old
    // adaptive throttle tiers (100KB→500ms / 200KB→2s / >500KB→5s) only
    // treated the symptom (O(conversation) payload per push) and were removed
    // once the root cause (full-list re-push) was gone.
    //
    // Content text still arrives via onContentDelta/onThinkingDelta (tiny
    // payloads), so the user sees streaming text in real time.  The full
    // updateMessages push remains for non-streaming updates and for the
    // single authoritative sync flushed at stream end.
    private static final int STREAMING_MIN_INTERVAL_MS = 150;

    // FIX: Heartbeat interval during streaming.  During tool execution phases
    // (command execution, file operations, etc.), no content deltas or message
    // updates arrive from the SDK.  Without a heartbeat, the frontend stall
    // watchdog may falsely trigger and prematurely end the streaming state.
    // This lightweight signal keeps the frontend watchdog alive.
    private static final int HEARTBEAT_INTERVAL_MS = 10_000;       // 10s

    private final Object lock = new Object();
    private final Alarm updateAlarm = new Alarm(Alarm.ThreadToUse.SWING_THREAD);
    private final Alarm heartbeatAlarm = new Alarm(Alarm.ThreadToUse.SWING_THREAD);
    private volatile boolean streamActive = false;
    private volatile boolean updateScheduled = false;
    private volatile long lastUpdateAtMs = 0L;
    private volatile long updateSequence = 0L;
    private volatile List<ClaudeSession.Message> pendingMessages = null;
    private volatile List<ClaudeSession.Message> lastSnapshot = null;
    // Incremental upsert state.  upsertModeActive flips on with the first
    // enqueueUpsert() of a stream: from then on full-list pushes are suppressed
    // (the list is retained only as the flush candidate) and mutations travel
    // as single-message upserts.  Both providers drive this channel now
    // (ClaudeMessageHandler and CodexMessageHandler); a provider that never
    // calls enqueueUpsert() would keep the legacy full-list streaming behaviour.
    private volatile boolean upsertModeActive = false;
    private volatile List<ClaudeSession.Message> pendingUpserts = null;

    private final JsCallbackTarget callbackTarget;

    /**
     * Callback interface to push data to the webview.
     */
    public interface JsCallbackTarget {
        void callJavaScript(String functionName, String... args);
        JBCefBrowser getBrowser();
        boolean isDisposed();
        HandlerContext getHandlerContext();

        /**
         * Fired when the stream transitions to inactive (end of a turn's
         * streaming segment). Lets the host run work that was deferred while the
         * stream was active — e.g. a session_updated reload held back so it does
         * not disturb the streaming bubble or race SessionState mutations.
         * Default no-op so existing targets need not implement it.
         */
        default void onStreamEnded() {}
    }

    public StreamMessageCoalescer(JsCallbackTarget callbackTarget) {
        this.callbackTarget = callbackTarget;
    }

    /**
     * Enqueue a message update for coalesced delivery.
     */
    public void enqueue(List<ClaudeSession.Message> messages) {
        if (callbackTarget.isDisposed()) {
            return;
        }
        // Defensive copy: the caller's list may be mutated on another thread,
        // so we snapshot it here to guarantee a consistent read in sendToWebView.
        final List<ClaudeSession.Message> snapshot = List.copyOf(messages);
        final boolean suppressFullPush;
        synchronized (lock) {
            pendingMessages = snapshot;
            // Upsert mode: structural updates flow through the incremental
            // upsertMessage channel, so the full list is NOT pushed mid-stream
            // (that re-push was the O(conversation) IPC cost this design
            // removes).  The snapshot is still retained as the flush candidate
            // for the authoritative end-of-stream sync.
            suppressFullPush = streamActive && upsertModeActive;
        }
        if (!suppressFullPush) {
            schedulePush();
        }
        // Restart heartbeat timer: real data just arrived, so the next heartbeat
        // should fire HEARTBEAT_INTERVAL_MS from now, not from the last heartbeat.
        if (streamActive) {
            startHeartbeat();
        }
    }

    /**
     * Enqueue a single mutated message for incremental (upsert) delivery.
     *
     * <p>Only meaningful while a stream is active; outside streaming the full
     * updateMessages channel already covers every mutation and this call is a
     * no-op.  The first upsert of a stream activates upsert mode, which
     * suppresses mid-stream full-list pushes (see {@link #enqueue}).  Multiple
     * upserts within one throttle window are merged into a single
     * {@code window.upsertMessage(jsonArray, seq)} call; re-upserting the same
     * Message instance keeps a single queue entry (the reference is serialized
     * at push time, so it always reflects the latest mutation).
     */
    public void enqueueUpsert(ClaudeSession.Message message) {
        if (callbackTarget.isDisposed() || message == null) {
            return;
        }
        synchronized (lock) {
            if (!streamActive) {
                return;
            }
            upsertModeActive = true;
            List<ClaudeSession.Message> queue = pendingUpserts;
            if (queue == null) {
                queue = new ArrayList<>();
                pendingUpserts = queue;
            }
            // ClaudeSession.Message does not override equals(), so remove() is
            // an identity check — exactly what we want for the shared mutable
            // assistant message of the current turn.
            queue.remove(message);
            queue.add(message);
        }
        schedulePush();
        // Same liveness contract as enqueue(): real data arrived mid-stream.
        startHeartbeat();
    }

    /**
     * Notify that a stream has started.
     */
    public void onStreamStart() {
        synchronized (lock) {
            streamActive = true;
            // Fresh turn: upsert mode re-arms on this turn's first enqueueUpsert.
            upsertModeActive = false;
            pendingUpserts = null;
        }
        startHeartbeat();
    }

    /**
     * Notify that a stream has ended.
     */
    public void onStreamEnd() {
        heartbeatAlarm.cancelAllRequests();
        synchronized (lock) {
            streamActive = false;
        }
        // Notify the host that the stream went inactive, so it can drain work
        // deferred during streaming (e.g. a background session_updated reload).
        // Done outside the lock: the host may synchronously schedule EDT work,
        // and holding `lock` across a foreign callback risks lock-ordering issues.
        callbackTarget.onStreamEnded();
    }

    /**
     * Reset stream state (e.g., on new session creation).
     *
     * @return the post-reset update sequence, to be forwarded to the frontend as
     *     a "sequence barrier". Any stale updateMessages from the previous
     *     session that were already dispatched to JS (and are queued in the JCEF
     *     IPC channel) carry a strictly smaller sequence, so the frontend's
     *     {@code __minAcceptedUpdateSequence} guard rejects them. This closes the
     *     race where a delayed old snapshot repopulates a list that "new session"
     *     just cleared.
     */
    public long resetStreamState() {
        updateAlarm.cancelAllRequests();
        heartbeatAlarm.cancelAllRequests();
        synchronized (lock) {
            streamActive = false;
            updateScheduled = false;
            pendingMessages = null;
            pendingUpserts = null;
            upsertModeActive = false;
            lastSnapshot = null;
            lastUpdateAtMs = 0L;
            return ++updateSequence;
        }
    }

    public boolean isStreamActive() {
        return streamActive;
    }

    /**
     * Flush any pending messages immediately and optionally run a callback afterwards.
     */
    public void flush(LongConsumer afterFlushOnEdt) {
        if (callbackTarget.isDisposed()) {
            return;
        }

        final List<ClaudeSession.Message> snapshot;
        final long sequence;
        synchronized (lock) {
            updateAlarm.cancelAllRequests();
            updateScheduled = false;
            // Pending upserts are superseded by the full snapshot flushed here:
            // the end-of-stream sync carries every increment in authoritative
            // form, so the incremental queue is simply dropped.
            pendingUpserts = null;
            upsertModeActive = false;
            snapshot = pendingMessages != null ? pendingMessages : lastSnapshot;
            pendingMessages = null;
            sequence = ++updateSequence;
        }

        if (snapshot == null) {
            if (afterFlushOnEdt != null) {
                final long finalSequence = sequence;
                ApplicationManager.getApplication().invokeLater(() -> afterFlushOnEdt.accept(finalSequence));
            }
            return;
        }

        sendToWebView(snapshot, sequence, afterFlushOnEdt);
    }

    /**
     * Dispose internal resources.
     */
    public void dispose() {
        try {
            updateAlarm.cancelAllRequests();
            updateAlarm.dispose();
        } catch (Exception e) {
            LOG.warn("Failed to dispose stream message update alarm: " + e.getMessage());
        }
        try {
            heartbeatAlarm.cancelAllRequests();
            heartbeatAlarm.dispose();
        } catch (Exception e) {
            LOG.warn("Failed to dispose heartbeat alarm: " + e.getMessage());
        }
    }

    /**
     * Compute the effective coalescing interval.  During streaming a fixed
     * 150ms applies: payloads are now incremental (upserts) or suppressed
     * entirely (full list), so the payload-size-adaptive tiers that guarded
     * against the full-list death spiral are no longer needed.
     */
    private int effectiveIntervalMs() {
        return streamActive ? STREAMING_MIN_INTERVAL_MS : UPDATE_INTERVAL_MS;
    }

    private void schedulePush() {
        if (callbackTarget.isDisposed()) {
            return;
        }

        final int delayMs;
        synchronized (lock) {
            if (updateScheduled) {
                return;
            }
            int intervalMs = effectiveIntervalMs();
            long elapsed = System.currentTimeMillis() - lastUpdateAtMs;
            delayMs = (int) Math.max(0L, intervalMs - elapsed);
            updateScheduled = true;
            ++updateSequence;
        }

        updateAlarm.addRequest(() -> {
            final List<ClaudeSession.Message> snapshot;
            final List<ClaudeSession.Message> upserts;
            final long sequence;
            synchronized (lock) {
                updateScheduled = false;
                lastUpdateAtMs = System.currentTimeMillis();
                if (streamActive && upsertModeActive) {
                    // Full list is retained for the end-of-stream flush, not pushed.
                    snapshot = null;
                } else {
                    snapshot = pendingMessages;
                    pendingMessages = null;
                }
                upserts = pendingUpserts;
                pendingUpserts = null;
                sequence = updateSequence;
            }

            if (callbackTarget.isDisposed()) {
                return;
            }

            // Upserts win over a pending full snapshot: both describe the same
            // mutations, but the upsert payload is O(changed) instead of
            // O(conversation).  The retained snapshot still reaches the
            // frontend via the end-of-stream flush.
            if (upserts != null && !upserts.isEmpty()) {
                sendUpsertsToWebView(upserts, sequence);
            } else if (snapshot != null) {
                sendToWebView(snapshot, sequence, null);
            }

            boolean hasPending;
            synchronized (lock) {
                hasPending = pendingUpserts != null
                        || (pendingMessages != null && !(streamActive && upsertModeActive));
            }
            if (hasPending && !callbackTarget.isDisposed()) {
                schedulePush();
            }
        }, delayMs);
    }

    private void sendToWebView(
            List<ClaudeSession.Message> messages,
            long sequence,
            LongConsumer afterSendOnEdt
    ) {
        // Keep the snapshot for potential re-flush after webview reload/recreate
        synchronized (lock) {
            lastSnapshot = messages;
        }

        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            final int payloadChars;
            final long payloadBuildMs;
            final String escapedMessagesJson;
            try {
                long buildStartedAt = System.nanoTime();
                String messagesJson = MessageJsonConverter.convertMessagesToJson(messages);
                payloadChars = messagesJson.length();
                escapedMessagesJson = JsUtils.escapeJs(messagesJson);
                payloadBuildMs = java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - buildStartedAt);

                if (payloadChars >= LARGE_UPDATE_PAYLOAD_CHARS || payloadBuildMs >= SLOW_PAYLOAD_BUILD_MS) {
                    LOG.info("[WebviewTransport] updateMessages payload chars=" + payloadChars
                            + ", messages=" + messages.size()
                            + ", buildMs=" + payloadBuildMs
                            + ", sequence=" + sequence);
                } else if (LOG.isDebugEnabled()) {
                    LOG.debug("[WebviewTransport] updateMessages payload chars=" + payloadChars
                            + ", messages=" + messages.size()
                            + ", buildMs=" + payloadBuildMs
                            + ", sequence=" + sequence);
                }
            } catch (Exception e) {
                LOG.warn("Failed to serialize messages for streaming update: " + e.getMessage(), e);
                if (afterSendOnEdt != null) {
                    final long finalSequence = sequence;
                    ApplicationManager.getApplication().invokeLater(() -> afterSendOnEdt.accept(finalSequence));
                }
                return;
            }

            ApplicationManager.getApplication().invokeLater(() -> {
                if (callbackTarget.isDisposed()) {
                    // FIX: Still run afterSendOnEdt even when disposed, so that
                    // onStreamEnd/showLoading(false) callbacks execute and clear
                    // streaming state. Without this, a dispose race leaves the
                    // frontend permanently stuck in "responding" state.
                    if (afterSendOnEdt != null) {
                        afterSendOnEdt.accept(sequence);
                    }
                    return;
                }

                synchronized (lock) {
                    if (sequence != updateSequence) {
                        // Message is stale — skip the webview push, but still
                        // run the after-send callback (e.g. onStreamEnd cleanup)
                        // so the frontend is not stuck in streaming state.
                        if (afterSendOnEdt != null) {
                            afterSendOnEdt.accept(sequence);
                        }
                        return;
                    }
                }

                // FIX: Wrap callJavaScript in try-catch so that a JCEF failure
                // (e.g., large payload rejection, disposed browser race) does not
                // prevent afterSendOnEdt from running.  When afterSendOnEdt carries
                // the onStreamEnd signal, failing to run it permanently freezes the UI.
                try {
                    callbackTarget.callJavaScript("updateMessages", escapedMessagesJson, String.valueOf(sequence));
                    MessageJsonConverter.pushUsageUpdateFromMessages(
                            messages,
                            callbackTarget.getHandlerContext(),
                            callbackTarget.getBrowser(),
                            callbackTarget.isDisposed()
                    );
                } catch (Exception e) {
                    LOG.warn("Failed to push updateMessages to webview (payload chars="
                            + escapedMessagesJson.length() + "): " + e.getMessage(), e);
                }

                if (afterSendOnEdt != null) {
                    afterSendOnEdt.accept(sequence);
                }
            });
        });
    }

    /**
     * Push one coalesced window of mutated messages via the incremental
     * {@code window.upsertMessage} channel.  Shares {@link #updateSequence}
     * with updateMessages so the frontend's sequence barrier applies uniformly.
     *
     * <p>Usage updates are NOT re-derived here: usage travels on its own
     * channel (SessionCallbackAdapter.onUsageUpdate, fed by [USAGE] tags and
     * assistant-message usage), so unlike {@link #sendToWebView} there is no
     * pushUsageUpdateFromMessages side effect.
     */
    private void sendUpsertsToWebView(List<ClaudeSession.Message> upserts, long sequence) {
        ApplicationManager.getApplication().executeOnPooledThread(() -> {
            final String escapedUpsertsJson;
            try {
                long buildStartedAt = System.nanoTime();
                // Reuse the full-list converter: the upsert payload is simply a
                // JSON array of the changed messages, with identical truncation.
                String upsertsJson = MessageJsonConverter.convertMessagesToJson(upserts);
                escapedUpsertsJson = JsUtils.escapeJs(upsertsJson);
                long payloadBuildMs = java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - buildStartedAt);
                if (LOG.isDebugEnabled()) {
                    LOG.debug("[WebviewTransport] upsertMessage payload chars=" + upsertsJson.length()
                            + ", messages=" + upserts.size()
                            + ", buildMs=" + payloadBuildMs
                            + ", sequence=" + sequence);
                }
            } catch (Exception e) {
                LOG.warn("Failed to serialize messages for upsert update: " + e.getMessage(), e);
                return;
            }

            ApplicationManager.getApplication().invokeLater(() -> {
                if (callbackTarget.isDisposed()) {
                    return;
                }

                synchronized (lock) {
                    if (sequence != updateSequence) {
                        // Stale upsert — a newer push (or the end-of-stream
                        // flush, which supersedes all increments) owns the channel.
                        return;
                    }
                }

                try {
                    callbackTarget.callJavaScript("upsertMessage", escapedUpsertsJson, String.valueOf(sequence));
                } catch (Exception e) {
                    LOG.warn("Failed to push upsertMessage to webview (payload chars="
                            + escapedUpsertsJson.length() + "): " + e.getMessage(), e);
                }
            });
        });
    }

    // ===== Streaming heartbeat =====

    /**
     * Start (or restart) the periodic heartbeat during streaming.
     * Sends a lightweight JS signal to the frontend to prevent the stall
     * watchdog from falsely triggering during tool execution phases where
     * no content deltas or message updates arrive from the SDK.
     */
    private void startHeartbeat() {
        heartbeatAlarm.cancelAllRequests();
        scheduleHeartbeat();
    }

    private void scheduleHeartbeat() {
        if (!streamActive || callbackTarget.isDisposed()) {
            return;
        }
        heartbeatAlarm.addRequest(() -> {
            if (!streamActive || callbackTarget.isDisposed()) {
                return;
            }
            try {
                callbackTarget.callJavaScript("onStreamingHeartbeat");
                if (LOG.isDebugEnabled()) {
                    LOG.debug("[Heartbeat] Sent streaming heartbeat to frontend");
                }
            } catch (Exception e) {
                LOG.warn("[Heartbeat] Failed to send heartbeat: " + e.getMessage());
            }
            // Schedule next heartbeat
            scheduleHeartbeat();
        }, HEARTBEAT_INTERVAL_MS);
    }
}
