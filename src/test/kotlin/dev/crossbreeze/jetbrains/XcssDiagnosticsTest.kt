package dev.crossbreeze.jetbrains

import com.intellij.javascript.nodejs.interpreter.NodeJsInterpreterManager
import com.intellij.javascript.nodejs.interpreter.NodeJsInterpreterRef
import com.intellij.javascript.nodejs.interpreter.local.NodeJsLocalInterpreter
import com.intellij.lang.annotation.HighlightSeverity
import com.intellij.openapi.actionSystem.IdeActions
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.lsp.api.LspClient
import com.intellij.platform.lsp.api.LspClientManager
import com.intellij.platform.lsp.api.LspClientManagerListener
import com.intellij.platform.lsp.api.LspServerState
import com.intellij.testFramework.LightProjectDescriptor
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.PsiTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.testFramework.fixtures.impl.TempDirTestFixtureImpl
import org.eclipse.lsp4j.ConfigurationItem
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap

class XcssDiagnosticsTest : BasePlatformTestCase() {
    private val descriptor = LightProjectDescriptor()
    override fun getProjectDescriptor() = descriptor
    override fun createTempDirTestFixture() = TempDirTestFixtureImpl()

    fun testStylesheetAndTypescriptDiagnosticsInEditor() {
        val settings = project.getService(CrossBreezeSettings::class.java)
        settings.state.enabled = false
        val node = System.getenv("CROSSBREEZE_TEST_NODE") ?: "node"
        NodeJsInterpreterManager.getInstance(project).setInterpreterRef(
            NodeJsInterpreterRef.create(NodeJsLocalInterpreter(node)), testRootDisposable,
        )
        val validStyle = "@vars { @provided --button-width: length; }\n.valid {}"
        val stylesheet = myFixture.tempDirFixture.createFile("theme.xcss", "$validStyle\nbogus;")
        myFixture.tempDirFixture.createFile("xcss-env.d.ts", """
            declare module '*.xcss' {
                export const styles: Record<string, string>;
                export const cssVars: Readonly<Record<string, string>>;
            }
        """.trimIndent())
        val config = myFixture.tempDirFixture.createFile("tsconfig.json", """{"files":["app.ts","xcss-env.d.ts"]}""")
        val script = myFixture.tempDirFixture.createFile("app.ts", "import { styles, cssVars } from './theme.xcss'; styles.missing;")
        if (!ProjectFileIndex.getInstance(project).isInContent(script)) PsiTestUtil.addContentRoot(module, script.parent)

        val manager = LspClientManager.getInstance(project)
        val received = ConcurrentHashMap<VirtualFile, Int>()
        manager.addListener(object : LspClientManagerListener {
            override fun diagnosticsReceived(lspClient: LspClient, file: VirtualFile) {
                if (lspClient.providerClass == CrossBreezeLspIntegrationProvider::class.java) received.merge(file, 1, Int::plus)
            }
        }, testRootDisposable)
        val editors = FileEditorManager.getInstance(project)
        settings.state.enabled = true
        val server = CrossBreezeDescriptor(project, Path.of("."))
        assertEquals(config.toNioPath().toUri().toString(), server.getWorkspaceConfiguration(ConfigurationItem().apply {
            scopeUri = server.getFileUri(script)
            section = "crossbreeze.typescriptProject"
        }))
        try {
            for ((file, code, token, fixed) in listOf(
                Example(stylesheet, "XC-105", "bogus", validStyle),
                Example(script, "XC-001", "missing", "import { styles, cssVars } from './theme.xcss'; styles.valid; cssVars.buttonWidth;"),
            )) {
                // Prepare the fixture before the real editor publishes its document version.
                myFixture.configureFromExistingVirtualFile(file)
                editors.openFile(file, true)
                val document = myFixture.editor.document
                fun highlight() = myFixture.doHighlighting().firstOrNull { it.description.orEmpty().contains(code) }
                PlatformTestUtil.waitWithEventsDispatching("No editor diagnostics for $code", { received.containsKey(file) }, 20)
                val diagnostic = requireNotNull(highlight()) { "No inline highlight for $code" }
                assertEquals(HighlightSeverity.ERROR, diagnostic.severity)
                assertEquals(token, document.text.substring(diagnostic.startOffset, diagnostic.endOffset))
                assertTrue(diagnostic.toolTip.orEmpty().contains(code))

                val before = received.getValue(file)
                WriteCommandAction.runWriteCommandAction(project) { document.setText(fixed) }
                PlatformTestUtil.waitWithEventsDispatching("No updated diagnostics after fixing $code", {
                    received.getOrDefault(file, 0) > before
                }, 20)
                assertNull(highlight())
            }
            val editor = myFixture.editor
            val expectedTokens = mapOf(
                XcssColors.TS_IMPORT to setOf("styles", "cssVars"),
                XcssColors.TS_CLASS_MEMBER to setOf("valid"),
                XcssColors.TS_PROVIDED_VARIABLE to setOf("buttonWidth"),
            )
            PlatformTestUtil.waitWithEventsDispatching("TypeScript XCSS highlighting was not applied", {
                val highlights = myFixture.doHighlighting()
                expectedTokens.all { (key, tokens) ->
                    highlights.filter { it.forcedTextAttributesKey == key }
                        .map { editor.document.text.substring(it.startOffset, it.endOffset) }.toSet() == tokens
                } && highlights.filter { it.forcedTextAttributesKey == XcssColors.TS_IMPORT }
                    .map { it.startOffset }.toSet() == Regex("\\b(styles|cssVars)\\b").findAll(editor.document.text)
                    .map { it.range.first }.toSet()
            }, 10)
            editor.caretModel.moveToOffset(editor.document.text.indexOf("styles") + 2)
            myFixture.performEditorAction(IdeActions.ACTION_GOTO_DECLARATION)
            PlatformTestUtil.waitWithEventsDispatching("Go to Declaration did not open the stylesheet for the named import", {
                editors.selectedFiles.firstOrNull() == stylesheet && editors.selectedTextEditor?.caretModel?.offset == 0
            }, 10)
        } finally {
            settings.state.enabled = false
            manager.stopClients(CrossBreezeLspIntegrationProvider::class.java)
            PlatformTestUtil.waitWithEventsDispatching("CrossBreeze did not stop", {
                manager.getClients(CrossBreezeLspIntegrationProvider::class.java)
                    .none { it.state == LspServerState.Running || it.state == LspServerState.Initializing }
            }, 20)
        }
    }

    private data class Example(
        val file: VirtualFile,
        val code: String,
        val token: String,
        val fixed: String,
    )
}
