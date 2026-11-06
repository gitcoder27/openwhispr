import { useTranslation } from "react-i18next";
import { useSettingsStore } from "../../stores/settingsStore";
import { SettingsPanel, SettingsPanelRow, SettingsRow } from "../ui/SettingsSection";
import { Toggle } from "../ui/toggle";

// Kill switch for the quiet-input boost (src/helpers/quietSpeechBoost.js).
export function QuietSpeechBoostSettings() {
  const { t } = useTranslation();
  const quietSpeechBoost = useSettingsStore((s) => s.quietSpeechBoost);
  const setQuietSpeechBoost = useSettingsStore((s) => s.setQuietSpeechBoost);

  return (
    <SettingsPanel>
      <SettingsPanelRow>
        <SettingsRow
          label={t("settingsPage.transcription.quietSpeechBoost.title")}
          description={t("settingsPage.transcription.quietSpeechBoost.description")}
        >
          <Toggle checked={quietSpeechBoost} onChange={setQuietSpeechBoost} />
        </SettingsRow>
      </SettingsPanelRow>
    </SettingsPanel>
  );
}
