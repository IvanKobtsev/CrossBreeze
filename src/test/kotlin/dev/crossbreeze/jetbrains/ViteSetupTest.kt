package dev.crossbreeze.jetbrains

import com.intellij.javascript.nodejs.interpreter.NodeJsInterpreterManager
import com.intellij.javascript.nodejs.interpreter.NodeJsInterpreterRef
import com.intellij.javascript.nodejs.interpreter.local.NodeJsLocalInterpreter
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.notification.Notification
import com.intellij.notification.Notifications
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.command.undo.UndoManager
import com.intellij.openapi.components.service
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.testFramework.LightProjectDescriptor
import com.intellij.testFramework.PlatformTestUtil
import com.intellij.testFramework.PsiTestUtil
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.testFramework.fixtures.impl.TempDirTestFixtureImpl
import kotlinx.coroutines.runBlocking

class ViteSetupTest : BasePlatformTestCase() {
    private val descriptor = LightProjectDescriptor()
    override fun getProjectDescriptor() = descriptor
    override fun createTempDirTestFixture() = TempDirTestFixtureImpl()

    fun testStartupOffersSetupWithoutAnXcssFileOrOpenEditor() {
        val manifest = myFixture.tempDirFixture.createFile("package.json", """{"devDependencies":{"vite":"^8"}}""")
        if (!ProjectFileIndex.getInstance(project).isInContent(manifest)) PsiTestUtil.addContentRoot(module, manifest.parent)
        val node = System.getenv("CROSSBREEZE_TEST_NODE") ?: "node"
        NodeJsInterpreterManager.getInstance(project).setInterpreterRef(
            NodeJsInterpreterRef.create(NodeJsLocalInterpreter(node)), testRootDisposable,
        )
        var offer: Notification? = null
        project.messageBus.connect(testRootDisposable).subscribe(Notifications.TOPIC, object : Notifications {
            override fun notify(notification: Notification) {
                if (notification.title.startsWith("XCSS setup for ")) offer = notification
            }
        })
        val descriptor = requireNotNull(PluginManagerCore.getPlugin(PluginId.getId("dev.crossbreeze.jetbrains")))
        runBlocking { ViteSetupStartup().apply { setPluginDescriptor(descriptor) }.execute(project) }
        PlatformTestUtil.waitWithEventsDispatching("No Vite setup notification after project startup", { offer != null }, 20)
        assertEquals(listOf("Review setup", "Don't show again"), offer?.actions?.map { it.templatePresentation.text })
        assertNull(manifest.parent.findChild("vite.config.ts"))
        assertNull(manifest.parent.findChild("vite.config.js"))
    }

    fun testReviewedSetupIsOneUndoableChange() {
        val config = myFixture.tempDirFixture.createFile("vite.config.ts", "export default {}")
        val root = config.parent
        if (!ProjectFileIndex.getInstance(project).isInContent(config)) PsiTestUtil.addContentRoot(module, root)
        val document = requireNotNull(FileDocumentManager.getInstance().getDocument(config))
        val declaration = root.path + "/xcss-env.d.ts"
        val plan = ViteSetupService.Plan(
            listOf(
                ViteSetupService.Edit(config.path, document.text, "export default { plugins: [] }"),
                ViteSetupService.Edit(declaration, null, XcssTypescriptSetup.CONTENT),
            ),
            emptyList(),
        )
        val setup = project.service<ViteSetupService>()
        assertTrue(setup.apply(root.path, plan))
        assertEquals("export default { plugins: [] }", document.text)
        assertNotNull(root.findChild("xcss-env.d.ts"))

        val undo = UndoManager.getInstance(project)
        assertTrue(undo.isUndoAvailable(null))
        undo.undo(null)
        assertEquals("export default {}", document.text)
        assertNull(root.findChild("xcss-env.d.ts"))
    }

    fun testStaleUnsavedDocumentPreventsAllWrites() {
        val config = myFixture.tempDirFixture.createFile("vite.config.ts", "export default {}")
        val root = config.parent
        if (!ProjectFileIndex.getInstance(project).isInContent(config)) PsiTestUtil.addContentRoot(module, root)
        val document = requireNotNull(FileDocumentManager.getInstance().getDocument(config))
        val plan = ViteSetupService.Plan(
            listOf(
                ViteSetupService.Edit(root.path + "/xcss-env.d.ts", null, XcssTypescriptSetup.CONTENT),
                ViteSetupService.Edit(config.path, document.text, "export default { plugins: [] }"),
            ),
            emptyList(),
        )
        WriteCommandAction.runWriteCommandAction(project) { document.setText("export default { base: '/app/' }") }
        assertFalse(project.service<ViteSetupService>().apply(root.path, plan))
        assertNull(root.findChild("xcss-env.d.ts"))
        assertEquals("export default { base: '/app/' }", document.text)
    }
}

