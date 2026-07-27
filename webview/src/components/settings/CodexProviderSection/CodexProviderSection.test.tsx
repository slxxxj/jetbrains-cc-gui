import { readFileSync } from 'node:fs';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import CodexProviderSection from './index';
import { sendToJava } from '../../../utils/bridge';
import { SPECIAL_PROVIDER_IDS } from '../../../types/provider';

vi.mock('../../../utils/bridge', () => ({
  sendToJava: vi.fn(),
  sendBridgeEvent: vi.fn(),
}));

const providerListStyles = readFileSync(
  'src/components/settings/ProviderList/style.module.less',
  'utf8'
);

const translations: Record<string, string> = {
  'settings.codexProvider.title': 'Codex Provider Management',
  'settings.codexProvider.description': 'Manage Codex providers',
  'settings.codexProvider.emptyProvider': 'No Codex providers configured',
  'settings.codexProvider.dialog.cliLoginProviderName': '使用本地配置信息',
  'settings.codexProvider.dialog.cliLoginProviderDescription': '显式授权读取：~/.codex/config.toml 和 auth.json',
  'settings.codexProvider.dialog.cliLoginAuthorizeTitle': 'Authorize Local Codex Config Access',
  'settings.codexProvider.dialog.cliLoginAuthorizeMessage': 'Read local Codex config files.',
  'settings.codexProvider.dialog.cliLoginAuthorizeDetail': 'Do not overwrite config.toml or auth.json.',
  'settings.codexProvider.dialog.cliLoginDisableTitle': 'Revoke Local Codex Config Authorization',
  'settings.codexProvider.dialog.cliLoginDisableMessage': 'Stop reading local Codex config files.',
  'settings.provider.loading': 'Loading',
  'settings.provider.allProviders': 'All Providers',
  'settings.provider.authorizeAndEnable': 'Authorize and Enable',
  'settings.provider.revokeAuthorization': 'Revoke Authorization',
  'settings.provider.enable': 'Enable',
  'settings.provider.inUse': 'In Use',
  'settings.provider.dragToSort': 'Drag to sort',
  'settings.provider.import': 'Import',
  'settings.provider.importFromCcSwitchUpdate': 'Import/Update from cc-switch',
  'settings.provider.importFromCcSwitchFile': 'Select cc-switch.db File to Import',
  'settings.provider.readingCcSwitch': 'Reading cc-switch configuration...',
  'settings.provider.editCcSwitchTitle': 'Edit cc-switch Configuration',
  'settings.provider.editCcSwitchWarning': 'Editing does not update cc-switch.',
  'settings.provider.continueEdit': 'Continue Editing',
  'settings.provider.convertAndEdit': 'Convert and Edit',
  'settings.provider.convertToPlugin': 'Convert to Plugin Configuration',
  'settings.provider.convertConfirmMessage': 'Convert "{{name}}" to a plugin configuration?',
  'settings.provider.convertDetailMessage': 'The cc-switch ID link will be disconnected.',
  'settings.provider.confirmConvert': 'Confirm Conversion',
  'settings.provider.convertSuccess': 'Converted to plugin configuration',
  'settings.provider.importDialog.title': 'Import Providers',
  'settings.provider.importDialog.summary': 'Total: {{total}}',
  'settings.provider.importDialog.newCount': '{{count}} new',
  'settings.provider.importDialog.updateCount': '{{count}} updated',
  'settings.provider.importDialog.columnName': 'Name',
  'settings.provider.importDialog.columnId': 'ID',
  'settings.provider.importDialog.columnStatus': 'Status',
  'settings.provider.importDialog.statusNew': 'New',
  'settings.provider.importDialog.statusUpdate': 'Update',
  'settings.provider.importDialog.selectedCount': 'Selected: {{count}}',
  'settings.provider.importDialog.confirmImport': 'Confirm Import',
  'common.add': 'Add',
  'common.cancel': 'Cancel',
  'common.edit': 'Edit',
  'common.delete': 'Delete',
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) => {
      const template = translations[key];
      if (!template) {
        return key;
      }
      if (!options) {
        return template;
      }
      return Object.entries(options).reduce(
        (result, [token, value]) => result.replace(`{{${token}}}`, value),
        template
      );
    },
  }),
}));

describe('CodexProviderSection', () => {
  const onAddCodexProvider = vi.fn();
  const onEditCodexProvider = vi.fn();
  const onDeleteCodexProvider = vi.fn();
  const onSwitchCodexProvider = vi.fn();
  const onRevokeCodexLocalConfigAuthorization = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders translated CLI login copy and confirms before enabling', () => {
    render(
      <CodexProviderSection
        codexProviders={[
          {
            id: SPECIAL_PROVIDER_IDS.CODEX_CLI_LOGIN,
            name: 'Virtual CLI Login',
            isActive: false,
          },
        ]}
        codexLoading={false}
        onAddCodexProvider={onAddCodexProvider}
        onEditCodexProvider={onEditCodexProvider}
        onDeleteCodexProvider={onDeleteCodexProvider}
        onSwitchCodexProvider={onSwitchCodexProvider}
        onRevokeCodexLocalConfigAuthorization={onRevokeCodexLocalConfigAuthorization}
      />
    );

    expect(screen.getByText('使用本地配置信息')).toBeTruthy();
    expect(screen.getByText('显式授权读取：~/.codex/config.toml 和 auth.json')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'Authorize and Enable' })[0]);

    expect(screen.getByText('Authorize Local Codex Config Access')).toBeTruthy();

    const dialog = screen.getByText('Authorize Local Codex Config Access').closest('div')?.parentElement;
    const confirmButton = dialog?.querySelectorAll('button')[1];
    expect(confirmButton).toBeTruthy();
    fireEvent.click(confirmButton as HTMLButtonElement);

    expect(onSwitchCodexProvider).toHaveBeenCalledWith(SPECIAL_PROVIDER_IDS.CODEX_CLI_LOGIN);
  });

  it('does not show account info when CLI login is active', () => {
    render(
      <CodexProviderSection
        codexProviders={[
          {
            id: SPECIAL_PROVIDER_IDS.CODEX_CLI_LOGIN,
            name: 'Virtual CLI Login',
            isActive: true,
          },
        ]}
        codexLoading={false}
        onAddCodexProvider={onAddCodexProvider}
        onEditCodexProvider={onEditCodexProvider}
        onDeleteCodexProvider={onDeleteCodexProvider}
        onSwitchCodexProvider={onSwitchCodexProvider}
        onRevokeCodexLocalConfigAuthorization={onRevokeCodexLocalConfigAuthorization}
      />
    );

    expect(screen.queryByText('Logged in as: Nicole Fox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Revoke Authorization' })).toBeTruthy();
  });

  it('revokes local authorization instead of switching directly when CLI login is active', () => {
    render(
      <CodexProviderSection
        codexProviders={[
          {
            id: SPECIAL_PROVIDER_IDS.CODEX_CLI_LOGIN,
            name: 'Virtual CLI Login',
            isActive: true,
          },
          {
            id: 'provider-1',
            name: 'Provider 1',
            isActive: false,
          },
        ]}
        codexLoading={false}
        onAddCodexProvider={onAddCodexProvider}
        onEditCodexProvider={onEditCodexProvider}
        onDeleteCodexProvider={onDeleteCodexProvider}
        onSwitchCodexProvider={onSwitchCodexProvider}
        onRevokeCodexLocalConfigAuthorization={onRevokeCodexLocalConfigAuthorization}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Revoke Authorization' }));

    const dialog = screen.getByText('Revoke Local Codex Config Authorization').closest('div')?.parentElement;
    const confirmButton = dialog?.querySelectorAll('button')[1];
    expect(confirmButton).toBeTruthy();
    fireEvent.click(confirmButton as HTMLButtonElement);

    expect(onRevokeCodexLocalConfigAuthorization).toHaveBeenCalledWith('provider-1');
    expect(onSwitchCodexProvider).not.toHaveBeenCalled();
  });

  it('allows long remarks to truncate instead of squeezing the action area', () => {
    const longRemark =
      'https://api.example.com/providers/' + 'very-long-segment/'.repeat(8);

    render(
      <CodexProviderSection
        codexProviders={[
          {
            id: 'provider-long-remark',
            name: 'xinghuapi',
            remark: longRemark,
            isActive: false,
          },
        ]}
        codexLoading={false}
        onAddCodexProvider={onAddCodexProvider}
        onEditCodexProvider={onEditCodexProvider}
        onDeleteCodexProvider={onDeleteCodexProvider}
        onSwitchCodexProvider={onSwitchCodexProvider}
        onRevokeCodexLocalConfigAuthorization={onRevokeCodexLocalConfigAuthorization}
      />
    );

    expect(screen.getByText(longRemark)).toBeTruthy();
    expect(providerListStyles).toMatch(/\.cardInfo\s*\{[\s\S]*min-width:\s*0;/);
    expect(providerListStyles).toMatch(/\.cardActions\s*\{[\s\S]*flex-shrink:\s*0;/);
    expect(providerListStyles).toMatch(
      /\.website\s*\{[\s\S]*overflow:\s*hidden;[\s\S]*text-overflow:\s*ellipsis;[\s\S]*white-space:\s*nowrap;/
    );
  });

  it('requests codex cc-switch previews from the import menu', () => {
    render(
      <CodexProviderSection
        codexProviders={[{ id: 'provider-1', name: 'Provider 1', isActive: false }]}
        codexLoading={false}
        onAddCodexProvider={onAddCodexProvider}
        onEditCodexProvider={onEditCodexProvider}
        onDeleteCodexProvider={onDeleteCodexProvider}
        onSwitchCodexProvider={onSwitchCodexProvider}
        onRevokeCodexLocalConfigAuthorization={onRevokeCodexLocalConfigAuthorization}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    fireEvent.click(screen.getByText('Import/Update from cc-switch'));
    expect(sendToJava).toHaveBeenCalledWith('preview_codex_cc_switch_import');

    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    fireEvent.click(screen.getByText('Select cc-switch.db File to Import'));
    expect(sendToJava).toHaveBeenCalledWith('open_file_chooser_for_codex_cc_switch');
  });

  it('shows the cc-switch badge and warns before editing a cc-switch provider', () => {
    const ccSwitchProvider = {
      id: 'codex-main',
      name: 'Codex Main',
      isActive: false,
      source: 'cc-switch',
      configToml: 'model = "gpt-5"\n',
      authJson: '{"OPENAI_API_KEY":"sk"}',
    };

    render(
      <CodexProviderSection
        codexProviders={[ccSwitchProvider]}
        codexLoading={false}
        onAddCodexProvider={onAddCodexProvider}
        onEditCodexProvider={onEditCodexProvider}
        onDeleteCodexProvider={onDeleteCodexProvider}
        onSwitchCodexProvider={onSwitchCodexProvider}
        onRevokeCodexLocalConfigAuthorization={onRevokeCodexLocalConfigAuthorization}
      />
    );

    expect(screen.getByText('cc-switch')).toBeTruthy();

    fireEvent.click(screen.getByTitle('Edit'));
    expect(screen.getByText('Edit cc-switch Configuration')).toBeTruthy();
    expect(onEditCodexProvider).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Continue Editing' }));
    expect(onEditCodexProvider).toHaveBeenCalledWith(ccSwitchProvider);
  });

  it('converts a cc-switch provider into a standalone plugin provider', () => {
    const addToast = vi.fn();
    const ccSwitchProvider = {
      id: 'codex-main',
      name: 'Codex Main',
      isActive: false,
      source: 'cc-switch',
      configToml: 'model = "gpt-5"\n',
      authJson: '{"OPENAI_API_KEY":"sk"}',
    };

    render(
      <CodexProviderSection
        codexProviders={[ccSwitchProvider]}
        codexLoading={false}
        onAddCodexProvider={onAddCodexProvider}
        onEditCodexProvider={onEditCodexProvider}
        onDeleteCodexProvider={onDeleteCodexProvider}
        onSwitchCodexProvider={onSwitchCodexProvider}
        onRevokeCodexLocalConfigAuthorization={onRevokeCodexLocalConfigAuthorization}
        addToast={addToast}
      />
    );

    fireEvent.click(screen.getByTitle('Convert to Plugin Configuration'));
    expect(screen.getByText(/Convert "Codex Main" to a plugin configuration\?/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm Conversion' }));

    expect(sendToJava).toHaveBeenCalledWith('add_codex_provider', {
      id: 'codex-main_local',
      name: 'Codex Main (Local)',
      isActive: false,
      configToml: 'model = "gpt-5"\n',
      authJson: '{"OPENAI_API_KEY":"sk"}',
    });
    expect(sendToJava).toHaveBeenCalledWith('delete_codex_provider', { id: 'codex-main' });
    expect(addToast).toHaveBeenCalledWith('Converted to plugin configuration', 'success');
  });

  it('opens the import dialog on codex_import_preview_result and saves selected providers', () => {
    render(
      <CodexProviderSection
        codexProviders={[]}
        codexLoading={false}
        onAddCodexProvider={onAddCodexProvider}
        onEditCodexProvider={onEditCodexProvider}
        onDeleteCodexProvider={onDeleteCodexProvider}
        onSwitchCodexProvider={onSwitchCodexProvider}
        onRevokeCodexLocalConfigAuthorization={onRevokeCodexLocalConfigAuthorization}
      />
    );

    const previewProviders = [
      { id: 'codex-main', name: 'Codex Main', source: 'cc-switch', configToml: 'model = "gpt-5"\n' },
    ];

    act(() => {
      window.codex_import_preview_result?.(JSON.stringify({ providers: previewProviders }));
    });

    expect(screen.getByText('Import Providers')).toBeTruthy();
    expect(screen.getByText('Codex Main')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Confirm Import' }));
    expect(sendToJava).toHaveBeenCalledWith('save_imported_codex_providers', {
      providers: previewProviders,
    });
  });
});
