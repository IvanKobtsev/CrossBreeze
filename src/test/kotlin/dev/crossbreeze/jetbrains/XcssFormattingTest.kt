package dev.crossbreeze.jetbrains

import com.intellij.application.options.CodeStyle
import com.intellij.platform.lsp.api.customization.LspFormattingSupport
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import org.eclipse.lsp4j.ConfigurationItem
import java.nio.file.Path

class XcssFormattingTest : BasePlatformTestCase() {
    private val formattingProjectDescriptor = com.intellij.testFramework.LightProjectDescriptor()
    override fun getProjectDescriptor() = formattingProjectDescriptor
    override fun createTempDirTestFixture() = com.intellij.testFramework.fixtures.impl.TempDirTestFixtureImpl()
    override fun setUp() {
        super.setUp()
        project.basePath?.let { java.nio.file.Files.createDirectories(Path.of(it)) }
        project.getService(CrossBreezeSettings::class.java).state.enabled = false
    }
    fun testFormattingSettingsAreScopedToFile() {
        val path = java.nio.file.Files.createTempFile("crossbreeze-format", ".xcss")
        path.toFile().deleteOnExit()
        val file = com.intellij.openapi.vfs.LocalFileSystem.getInstance().refreshAndFindFileByNioFile(path)!!
        myFixture.configureFromExistingVirtualFile(file)
        val settings = CodeStyle.getSettings(project).clone()
        settings.AUTODETECT_INDENTS = false
        val common = settings.getCommonSettings(XcssLanguage)
        common.initIndentOptions().apply { INDENT_SIZE = 2; TAB_SIZE = 4; USE_TAB_CHARACTER = true }
        settings.getIndentOptions(XcssFileType.INSTANCE).apply { INDENT_SIZE = 2; TAB_SIZE = 4; USE_TAB_CHARACTER = true }
        settings.setRightMargin(XcssLanguage, 100)
        settings.LINE_SEPARATOR = "\r\n"
        CodeStyle.doWithTemporarySettings(project, settings, Runnable {
            com.intellij.psi.codeStyle.CodeStyleSettingsManager.getInstance(project).notifyCodeStyleSettingsChanged()
            val descriptor = CrossBreezeDescriptor(project, Path.of("."))
            val item = ConfigurationItem().apply {
                section = "crossbreeze.formatting"
                scopeUri = descriptor.getFileUri(file)
            }
            val options = descriptor.getWorkspaceConfiguration(item) as Map<*, *>
            assertEquals(4, options["tabWidth"])
            assertEquals(true, options["useTabs"])
            assertEquals(100, options["printWidth"])
            assertEquals("crlf", options["endOfLine"])
            val formatting = descriptor.lspCustomization.formattingCustomizer as LspFormattingSupport
            assertTrue(formatting.shouldFormatThisFileExclusivelyByServer(file, false, true))
            item.section = "unrelated"
            assertNull(descriptor.getWorkspaceConfiguration(item))
        })
    }
    fun testDefaultCodeStyle() {
        val settings = XcssCodeStyleProvider().defaultCommonSettings
        assertEquals(80, settings.RIGHT_MARGIN)
        assertEquals(2, settings.indentOptions!!.INDENT_SIZE)
        assertFalse(settings.indentOptions!!.USE_TAB_CHARACTER)
    }
    fun testReformatActionAndUndo() {
        val node = System.getenv("CROSSBREEZE_TEST_NODE") ?: "node"
        com.intellij.javascript.nodejs.interpreter.NodeJsInterpreterManager.getInstance(project).setInterpreterRef(
            com.intellij.javascript.nodejs.interpreter.NodeJsInterpreterRef.create(
                com.intellij.javascript.nodejs.interpreter.local.NodeJsLocalInterpreter(node)), testRootDisposable)
        project.getService(CrossBreezeSettings::class.java).state.enabled = true
        val source = ".a{color:red}"
        myFixture.configureFromExistingVirtualFile(myFixture.tempDirFixture.createFile("format.xcss", source))
        val manager = com.intellij.platform.lsp.api.LspClientManager.getInstance(project)
        val provider = com.intellij.openapi.extensions.ExtensionPointName.create<com.intellij.platform.lsp.api.LspIntegrationProvider>("com.intellij.platform.lsp.integrationProvider")
            .extensionList.filterIsInstance<CrossBreezeLspIntegrationProvider>().single()
        manager.ensureClientStarted(CrossBreezeLspIntegrationProvider::class.java, provider.descriptorFor(project))
        try {
            com.intellij.testFramework.PlatformTestUtil.waitWithEventsDispatching("XCSS language server did not start", {
                manager.getClients(CrossBreezeLspIntegrationProvider::class.java).any { it.state == com.intellij.platform.lsp.api.LspServerState.Running }
            }, 20)
            // Fixture editors bypass the normal file-open synchronization listener.
            val client = manager.getClients(CrossBreezeLspIntegrationProvider::class.java).single()
            val uri = client.getDocumentIdentifier(myFixture.file.virtualFile).uri
            client.sendNotification { server ->
                server.textDocumentService.didOpen(org.eclipse.lsp4j.DidOpenTextDocumentParams(
                    org.eclipse.lsp4j.TextDocumentItem(uri, "xcss", 1, source)))
            }
            myFixture.performEditorAction(com.intellij.openapi.actionSystem.IdeActions.ACTION_EDITOR_REFORMAT)
            com.intellij.testFramework.PlatformTestUtil.waitWithEventsDispatching("XCSS Reformat Code did not apply edits", {
                myFixture.editor.document.text == ".a {\n  color: red;\n}\n"
            }, 20)
            myFixture.performEditorAction(com.intellij.openapi.actionSystem.IdeActions.ACTION_UNDO)
            myFixture.checkResult(source)
        } finally {
            project.getService(CrossBreezeSettings::class.java).state.enabled = false
            manager.stopClients(CrossBreezeLspIntegrationProvider::class.java)
            com.intellij.testFramework.PlatformTestUtil.waitWithEventsDispatching("XCSS language server did not stop", {
                manager.getClients(CrossBreezeLspIntegrationProvider::class.java).none { it.state == com.intellij.platform.lsp.api.LspServerState.Running || it.state == com.intellij.platform.lsp.api.LspServerState.Initializing }
            }, 20)
        }
    }
    fun testNativeColorProviderChangesLiteralAndUndo() {
        val node = System.getenv("CROSSBREEZE_TEST_NODE") ?: "node"
        com.intellij.javascript.nodejs.interpreter.NodeJsInterpreterManager.getInstance(project).setInterpreterRef(
            com.intellij.javascript.nodejs.interpreter.NodeJsInterpreterRef.create(
                com.intellij.javascript.nodejs.interpreter.local.NodeJsLocalInterpreter(node)), testRootDisposable)
        project.getService(CrossBreezeSettings::class.java).state.enabled = true
        val source = ".a { color: red; }"
        myFixture.configureFromExistingVirtualFile(myFixture.tempDirFixture.createFile("format.xcss", source))
        val manager = com.intellij.platform.lsp.api.LspClientManager.getInstance(project)
        val provider = com.intellij.openapi.extensions.ExtensionPointName.create<com.intellij.platform.lsp.api.LspIntegrationProvider>("com.intellij.platform.lsp.integrationProvider")
            .extensionList.filterIsInstance<CrossBreezeLspIntegrationProvider>().single()
        manager.ensureClientStarted(CrossBreezeLspIntegrationProvider::class.java, provider.descriptorFor(project))
        try {
            com.intellij.testFramework.PlatformTestUtil.waitWithEventsDispatching("XCSS language server did not start", {
                manager.getClients(CrossBreezeLspIntegrationProvider::class.java).any { it.state == com.intellij.platform.lsp.api.LspServerState.Running }
            }, 20)
            // Fixture editors bypass the normal file-open synchronization listener.
            val client = manager.getClients(CrossBreezeLspIntegrationProvider::class.java).single()
            val uri = client.getDocumentIdentifier(myFixture.file.virtualFile).uri
            client.sendNotification { server ->
                server.textDocumentService.didOpen(org.eclipse.lsp4j.DidOpenTextDocumentParams(
                    org.eclipse.lsp4j.TextDocumentItem(uri, "xcss", 1, source)))
            }
            val provider = XcssColorProvider()
            val element = myFixture.file.findElementAt(source.indexOf("red"))!!
            val future = com.intellij.openapi.application.ReadAction.nonBlocking<java.awt.Color?> {
                provider.getColorFrom(element)
            }.submit(com.intellij.util.concurrency.AppExecutorUtil.getAppExecutorService())
            com.intellij.testFramework.PlatformTestUtil.waitWithEventsDispatching("Color icon lookup did not finish", { future.isDone }, 20)
            assertEquals(java.awt.Color.RED, future.get())
            provider.setColorTo(element, java.awt.Color(0, 255, 0, 128))
            com.intellij.testFramework.PlatformTestUtil.waitWithEventsDispatching("Color picker did not apply its edit", {
                myFixture.editor.document.text == ".a { color: #00ff0080; }"
            }, 20)
            myFixture.performEditorAction(com.intellij.openapi.actionSystem.IdeActions.ACTION_UNDO)
            myFixture.checkResult(source)
        } finally {
            project.getService(CrossBreezeSettings::class.java).state.enabled = false
            manager.stopClients(CrossBreezeLspIntegrationProvider::class.java)
            com.intellij.testFramework.PlatformTestUtil.waitWithEventsDispatching("XCSS language server did not stop", {
                manager.getClients(CrossBreezeLspIntegrationProvider::class.java).none { it.state == com.intellij.platform.lsp.api.LspServerState.Running || it.state == com.intellij.platform.lsp.api.LspServerState.Initializing }
            }, 20)
        }
    }
    fun testModifierHoverResolvesWithoutNavigationAction() {
        val node = System.getenv("CROSSBREEZE_TEST_NODE") ?: "node"
        com.intellij.javascript.nodejs.interpreter.NodeJsInterpreterManager.getInstance(project).setInterpreterRef(
            com.intellij.javascript.nodejs.interpreter.NodeJsInterpreterRef.create(
                com.intellij.javascript.nodejs.interpreter.local.NodeJsLocalInterpreter(node)), testRootDisposable)
        project.getService(CrossBreezeSettings::class.java).state.enabled = true
        val source = "@vars { --tone: color = red; } .a { color: --tone; }"
        myFixture.configureFromExistingVirtualFile(myFixture.tempDirFixture.createFile("format.xcss", source))
        val manager = com.intellij.platform.lsp.api.LspClientManager.getInstance(project)
        val provider = com.intellij.openapi.extensions.ExtensionPointName.create<com.intellij.platform.lsp.api.LspIntegrationProvider>("com.intellij.platform.lsp.integrationProvider")
            .extensionList.filterIsInstance<CrossBreezeLspIntegrationProvider>().single()
        manager.ensureClientStarted(CrossBreezeLspIntegrationProvider::class.java, provider.descriptorFor(project))
        try {
            com.intellij.testFramework.PlatformTestUtil.waitWithEventsDispatching("XCSS language server did not start", {
                manager.getClients(CrossBreezeLspIntegrationProvider::class.java).any { it.state == com.intellij.platform.lsp.api.LspServerState.Running }
            }, 20)
            // Fixture editors bypass the normal file-open synchronization listener.
            val client = manager.getClients(CrossBreezeLspIntegrationProvider::class.java).single()
            val uri = client.getDocumentIdentifier(myFixture.file.virtualFile).uri
            client.sendNotification { server ->
                server.textDocumentService.didOpen(org.eclipse.lsp4j.DidOpenTextDocumentParams(
                    org.eclipse.lsp4j.TextDocumentItem(uri, "xcss", 1, source)))
            }
            val offset = source.lastIndexOf("--tone") + 2
            val future = com.intellij.openapi.application.ReadAction.nonBlocking<Pair<com.intellij.psi.PsiReference?, com.intellij.psi.PsiElement?>> {
                val reference = myFixture.file.findElementAt(offset)!!.parent.reference
                reference to reference?.resolve()
            }.submit(com.intellij.util.concurrency.AppExecutorUtil.getAppExecutorService())
            com.intellij.testFramework.PlatformTestUtil.waitWithEventsDispatching("Modifier hover lookup did not finish", { future.isDone }, 20)
            val (resolvedReference, resolvedTarget) = future.get()
            val reference = resolvedReference!!
            assertEquals(com.intellij.openapi.util.TextRange(0, 6), reference.rangeInElement)
            assertEquals(source.lastIndexOf("--tone"), reference.element.textRange.startOffset)
            val target = resolvedTarget!!
            assertEquals(source.indexOf("--tone"), target.textRange.startOffset)
        } finally {
            project.getService(CrossBreezeSettings::class.java).state.enabled = false
            manager.stopClients(CrossBreezeLspIntegrationProvider::class.java)
            com.intellij.testFramework.PlatformTestUtil.waitWithEventsDispatching("XCSS language server did not stop", {
                manager.getClients(CrossBreezeLspIntegrationProvider::class.java).none { it.state == com.intellij.platform.lsp.api.LspServerState.Running || it.state == com.intellij.platform.lsp.api.LspServerState.Initializing }
            }, 20)
        }
    }
    fun testUnavailableServerLeavesSourceUnchanged() {
        myFixture.configureByText("format.xcss", ".a{color:red}")
        myFixture.performEditorAction(com.intellij.openapi.actionSystem.IdeActions.ACTION_EDITOR_REFORMAT)
        myFixture.checkResult(".a{color:red}")
    }
}
