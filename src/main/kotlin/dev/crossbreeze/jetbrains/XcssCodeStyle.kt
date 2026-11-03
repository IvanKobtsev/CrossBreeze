package dev.crossbreeze.jetbrains

import com.intellij.application.options.CodeStyleAbstractConfigurable
import com.intellij.application.options.CodeStyleAbstractPanel
import com.intellij.application.options.TabbedLanguageCodeStylePanel
import com.intellij.application.options.SmartIndentOptionsEditor
import com.intellij.psi.codeStyle.CodeStyleSettings
import com.intellij.psi.codeStyle.CodeStyleSettingsCustomizable
import com.intellij.psi.codeStyle.CommonCodeStyleSettings
import com.intellij.psi.codeStyle.LanguageCodeStyleSettingsProvider

class XcssCodeStyleProvider : LanguageCodeStyleSettingsProvider() {
    override fun getLanguage() = XcssLanguage
    override fun getCodeSample(settingsType: SettingsType) = """
        @injection paint(${'$'}color: color = red) {
          color: ${'$'}color;
        }
        .button {
          @:paint(blue);
        }
    """.trimIndent()
    override fun customizeDefaults(commonSettings: CommonCodeStyleSettings, indentOptions: CommonCodeStyleSettings.IndentOptions) {
        indentOptions.INDENT_SIZE = 2
        indentOptions.TAB_SIZE = 2
        indentOptions.CONTINUATION_INDENT_SIZE = 2
        commonSettings.RIGHT_MARGIN = 80
    }
    override fun customizeSettings(consumer: CodeStyleSettingsCustomizable, settingsType: SettingsType) {
        if (settingsType == SettingsType.WRAPPING_AND_BRACES_SETTINGS) consumer.showStandardOptions("RIGHT_MARGIN")
    }
    override fun getIndentOptionsEditor() = SmartIndentOptionsEditor()
    override fun createConfigurable(settings: CodeStyleSettings, modelSettings: CodeStyleSettings) =
        object : CodeStyleAbstractConfigurable(settings, modelSettings, "XCSS") {
            override fun createPanel(settings: CodeStyleSettings): CodeStyleAbstractPanel =
                object : TabbedLanguageCodeStylePanel(XcssLanguage, currentSettings, settings) {
                    override fun initTabs(settings: CodeStyleSettings) {
                        addIndentOptionsTab(settings)
                        addWrappingAndBracesTab(settings)
                    }
                }
        }
}
