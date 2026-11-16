package dev.crossbreeze.jetbrains

import com.intellij.openapi.wm.ToolWindow
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.ui.content.ContentFactory
import java.lang.reflect.Proxy

class CrossBreezeToolWindowTest : BasePlatformTestCase() {
    fun testContentCreationWithoutPluginDescriptorCallback() {
        val manager = ContentFactory.getInstance().createContentManager(false, project)
        com.intellij.openapi.util.Disposer.register(testRootDisposable, manager)
        val window = Proxy.newProxyInstance(
            ToolWindow::class.java.classLoader, arrayOf(ToolWindow::class.java)
        ) { _, method, _ ->
            check(method.name == "getContentManager") { "Unexpected call: ${method.name}" }
            manager
        } as ToolWindow

        CrossBreezeToolWindowFactory().createToolWindowContent(project, window)

        assertEquals(1, manager.contentCount)
        assertNotNull(manager.contents.single().component)
    }
}
