package com.codeaide.session;

import com.codeaide.handler.core.HandlerContext;
import com.intellij.ui.jcef.JBCefBrowser;
import org.junit.Test;

import java.util.List;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * Lifecycle tests for the incremental upsert channel on the REAL
 * {@link StreamMessageCoalescer}.
 *
 * <p>The push path itself (Alarm → pooled-thread serialization → JCEF) needs a
 * running IntelliJ application and is covered by manual smoke tests; what can
 * be asserted here is the channel's gating contract:
 *
 * <ul>
 *   <li>upserts are ignored outside an active stream (the full updateMessages
 *       channel covers every mutation there);</li>
 *   <li>upserts stay ignored after stream end and after resetStreamState(),
 *       so a late-arriving mutation cannot resurrect upsert mode;</li>
 *   <li>the onStreamEnded host hook contract is unaffected by upsert traffic.</li>
 * </ul>
 */
public class StreamMessageCoalescerUpsertTest {

    /** Minimal JsCallbackTarget that counts JS calls and onStreamEnded() firings. */
    private static final class CountingTarget implements StreamMessageCoalescer.JsCallbackTarget {
        final AtomicInteger jsCallCount = new AtomicInteger();
        final AtomicInteger streamEndedCount = new AtomicInteger();

        @Override public void callJavaScript(String functionName, String... args) {
            jsCallCount.incrementAndGet();
        }
        @Override public JBCefBrowser getBrowser() { return null; }
        @Override public boolean isDisposed() { return false; }
        @Override public HandlerContext getHandlerContext() { return null; }
        @Override public void onStreamEnded() { streamEndedCount.incrementAndGet(); }
    }

    private static ClaudeSession.Message assistantMessage() {
        return new ClaudeSession.Message(ClaudeSession.Message.Type.ASSISTANT, "partial");
    }

    @Test
    public void upsertIgnoredWhenStreamInactive() {
        CountingTarget target = new CountingTarget();
        StreamMessageCoalescer coalescer = new StreamMessageCoalescer(target);
        try {
            // No onStreamStart: the full updateMessages channel owns this phase,
            // so enqueueUpsert must be a synchronous no-op.
            coalescer.enqueueUpsert(assistantMessage());
            assertFalse(coalescer.isStreamActive());
            assertEquals("no JS pushed outside streaming", 0, target.jsCallCount.get());
        } finally {
            coalescer.dispose();
        }
    }

    @Test
    public void upsertIgnoredAfterStreamEnd() {
        CountingTarget target = new CountingTarget();
        StreamMessageCoalescer coalescer = new StreamMessageCoalescer(target);
        try {
            coalescer.onStreamStart();
            coalescer.onStreamEnd();
            assertFalse(coalescer.isStreamActive());

            // A mutation arriving after stream end (e.g. error-path message)
            // must not re-arm the incremental channel.
            coalescer.enqueueUpsert(assistantMessage());
            assertEquals("no upsert JS after stream end", 0, target.jsCallCount.get());
            assertEquals("stream end hook fired exactly once", 1, target.streamEndedCount.get());
        } finally {
            coalescer.dispose();
        }
    }

    @Test
    public void upsertIgnoredAfterResetStreamState() {
        CountingTarget target = new CountingTarget();
        StreamMessageCoalescer coalescer = new StreamMessageCoalescer(target);
        try {
            coalescer.onStreamStart();
            long barrier = coalescer.resetStreamState();
            assertTrue("reset returns the sequence barrier", barrier > 0);

            coalescer.enqueueUpsert(assistantMessage());
            assertEquals("no upsert JS after reset", 0, target.jsCallCount.get());
            assertEquals("reset must not fire the drain hook", 0, target.streamEndedCount.get());
        } finally {
            coalescer.dispose();
        }
    }

    @Test
    public void streamEndHookUnaffectedByUpsertLifecycle() {
        // Mirroring StreamMessageCoalescerStreamEndHookTest: enqueueUpsert calls
        // interleaved with start/end must not perturb the per-turn hook contract.
        CountingTarget target = new CountingTarget();
        StreamMessageCoalescer coalescer = new StreamMessageCoalescer(target);
        try {
            for (int i = 0; i < 3; i++) {
                coalescer.onStreamStart();
                // Active-stream upserts schedule a coalesced push but never fire
                // the hook; only onStreamEnd does.
                coalescer.enqueueUpsert(assistantMessage());
                assertEquals("upsert must not fire the drain hook", i, target.streamEndedCount.get());
                coalescer.onStreamEnd();
            }
            assertEquals("hook fires once per turn", 3, target.streamEndedCount.get());
            assertFalse(coalescer.isStreamActive());
        } finally {
            coalescer.dispose();
        }
    }

    @Test
    public void fullListEnqueueStillAcceptedOutsideUpsertMode() {
        // Providers that never upsert (e.g. Codex) keep the legacy behaviour:
        // enqueue() during streaming schedules a full-list push.  The push
        // itself needs an IntelliJ application; here we only assert the enqueue
        // path does not throw or wedge the coalescer state machine.
        CountingTarget target = new CountingTarget();
        StreamMessageCoalescer coalescer = new StreamMessageCoalescer(target);
        try {
            coalescer.onStreamStart();
            coalescer.enqueue(List.of(assistantMessage()));
            assertTrue(coalescer.isStreamActive());
            coalescer.onStreamEnd();
            assertEquals(1, target.streamEndedCount.get());
        } finally {
            coalescer.dispose();
        }
    }
}
