package dev.crossbreeze.jetbrains

import com.intellij.openapi.components.service
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.google.gson.JsonParser
import java.awt.Component
import java.awt.Container
import java.nio.file.Files
import java.nio.file.Path
import java.util.Comparator
import javax.swing.JButton
import javax.swing.JTextField

class CrossFigmaConfigurationTest : BasePlatformTestCase() {
    fun testImportWaitsForExplicitSaveAndPreservesUnrelatedConfiguration() {
        val root = Files.createTempDirectory("crossbreeze-config-test")
        val state = project.service<CrossBreezeImportState>()
        val old = state.state
        val data = CrossBreezeImportState.Data()
        data.target = root.toString()
        data.snapshots[root.toString()] = """{"format":"crossfigma.snapshot","version":1,"collections":[],"variables":[],"styles":{"text":[],"paint":[],"effect":[],"grid":[]}}"""
        state.loadState(data)
        val config = root.resolve("xcss.config.json")
        Files.writeString(config, """{"other":{"keep":true},"cross-figma":{"output":"tokens"}}""")
        val panel = CrossBreezeImportPanel(project, Path.of("."))
        fun descendants(component: Component): List<Component> = listOf(component) + if (component is Container) component.components.flatMap(::descendants) else emptyList()
        try {
            assertFalse(Files.exists(root.resolve("tokens")))
            val controls = descendants(panel.component)
            controls.filterIsInstance<JTextField>().single().text = "new-tokens"
            controls.filterIsInstance<JButton>().single { it.text == "Save config" }.doClick()
            val saved = JsonParser.parseString(Files.readString(config)).asJsonObject
            assertTrue(saved.getAsJsonObject("other")["keep"].asBoolean)
            assertEquals("new-tokens", saved.getAsJsonObject("cross-figma")["output"].asString)
            assertFalse(Files.exists(root.resolve("new-tokens")))
            Files.writeString(config, """{"external":true}""")
            controls.filterIsInstance<JTextField>().single().text = "overwrite"
            controls.filterIsInstance<JButton>().single { it.text == "Save config" }.doClick()
            assertEquals("""{"external":true}""", Files.readString(config))
        } finally {
            panel.dispose(); state.loadState(old)
            Files.walk(root).use { it.sorted(Comparator.reverseOrder()).forEach(Files::delete) }
        }
    }
}
