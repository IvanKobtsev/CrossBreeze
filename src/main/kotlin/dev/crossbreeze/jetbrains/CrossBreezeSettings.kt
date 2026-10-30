package dev.crossbreeze.jetbrains

import com.google.gson.Gson
import com.google.gson.JsonParser
import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.openapi.options.Configurable
import com.intellij.openapi.options.ConfigurationException
import com.intellij.openapi.project.Project
import com.intellij.platform.lsp.api.LspClientManager
import java.awt.BorderLayout
import javax.swing.JCheckBox
import javax.swing.JLabel
import javax.swing.JPanel
import javax.swing.JScrollPane
import javax.swing.JTextArea

@Service(Service.Level.PROJECT)
@State(name = "CrossBreeze", storages = [Storage("crossbreeze.xml")])
class CrossBreezeSettings : PersistentStateComponent<CrossBreezeSettings.Data> {
    data class Data(var enabled: Boolean = true, var aliases: String = "{}", var checkCssProperties: Boolean = true, var checkCssValues: Boolean = true)
    private var data = Data()
    override fun getState() = data
    override fun loadState(state: Data) { data = state }
    fun aliases(): Map<String, List<String>> = parseAliases(data.aliases)
    companion object {
        internal fun parseAliases(text: String): Map<String, List<String>> {
            val value = JsonParser.parseString(text)
            require(value.isJsonObject) { "Aliases must be a JSON object." }
            return value.asJsonObject.entrySet().associate { (key, targets) ->
                require(key.isNotBlank() && key.count { it == '*' } <= 1) { "Alias names must be nonempty and contain at most one wildcard." }
                require(targets.isJsonArray && targets.asJsonArray.size() > 0) { "Each alias must have a nonempty array of paths." }
                key to targets.asJsonArray.map { target ->
                    require(target.isJsonPrimitive && target.asJsonPrimitive.isString && target.asString.isNotBlank()) { "Alias paths must be nonempty strings." }
                    target.asString
                }
            }
        }
    }
}
class CrossBreezeConfigurable(private val project: Project) : Configurable {
    private val enabled = JCheckBox("Enable CrossBreeze")
    private val checkCssProperties = JCheckBox("Check CSS property names")
    private val checkCssValues = JCheckBox("Check CSS values and types")
    private val aliases = JTextArea(10, 50)
    override fun getDisplayName() = "CrossBreeze"
    override fun createComponent() = JPanel(BorderLayout(0, 8)).apply {
        add(JPanel(BorderLayout()).apply {
            add(JPanel(java.awt.GridLayout(0, 1)).apply {
                add(enabled)
                add(checkCssProperties)
                add(checkCssValues)
            }, BorderLayout.NORTH)
            add(JLabel("Alias overrides (JSON object of path arrays, relative to the content root):"), BorderLayout.SOUTH)
        }, BorderLayout.NORTH)
        add(JScrollPane(aliases), BorderLayout.CENTER)
        add(JLabel("Uses the configured local Node.js runtime. Changes restart the language server."), BorderLayout.SOUTH)
    }
    override fun isModified(): Boolean {
        val state = project.service<CrossBreezeSettings>().state
        return enabled.isSelected != state.enabled || aliases.text != state.aliases ||
            checkCssProperties.isSelected != state.checkCssProperties || checkCssValues.isSelected != state.checkCssValues
    }
    override fun reset() {
        val state = project.service<CrossBreezeSettings>().state
        enabled.isSelected = state.enabled; aliases.text = state.aliases
        checkCssProperties.isSelected = state.checkCssProperties; checkCssValues.isSelected = state.checkCssValues
    }
    override fun apply() {
        try { CrossBreezeSettings.parseAliases(aliases.text) }
        catch (error: Exception) { throw ConfigurationException(error.message ?: "Invalid aliases") }
        val settings = project.service<CrossBreezeSettings>()
        settings.loadState(CrossBreezeSettings.Data(enabled.isSelected, aliases.text, checkCssProperties.isSelected, checkCssValues.isSelected))
        project.service<CrossBreezeRuntime>().reset()
        LspClientManager.getInstance(project).stopAndRestartClientsIfNeeded(CrossBreezeLspIntegrationProvider::class.java)
    }
}
