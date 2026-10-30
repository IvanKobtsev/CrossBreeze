package dev.crossbreeze.jetbrains

import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.StatusBar
import com.intellij.openapi.wm.StatusBarWidget
import com.intellij.openapi.wm.StatusBarWidgetFactory
import com.intellij.platform.lsp.api.LspClientManager
import com.intellij.util.Consumer
import java.awt.event.MouseEvent

class CrossBreezeRestartAction : AnAction() {
    override fun actionPerformed(event: AnActionEvent) { event.project?.let(::restart) }
    companion object {
        internal fun restart(project: Project) {
            project.service<CrossBreezeRuntime>().reset()
            LspClientManager.getInstance(project).stopAndRestartClientsIfNeeded(CrossBreezeLspIntegrationProvider::class.java)
        }
    }
}
class CrossBreezeStatusWidgetFactory : StatusBarWidgetFactory {
    override fun getId() = "CrossBreeze"
    override fun getDisplayName() = "CrossBreeze"
    override fun isAvailable(project: Project) = true
    override fun createWidget(project: Project): StatusBarWidget = CrossBreezeStatusWidget(project)
    override fun canBeEnabledOn(statusBar: StatusBar) = true
}
private class CrossBreezeStatusWidget(private val project: Project) : StatusBarWidget, StatusBarWidget.TextPresentation {
    override fun ID() = "CrossBreeze"
    override fun getPresentation() = this
    override fun getText() = "CrossBreeze: ${project.service<CrossBreezeRuntime>().status}"
    override fun getAlignment() = 0f
    override fun getTooltipText() = "XCSS language service. Click to restart."
    override fun getClickConsumer() = Consumer<MouseEvent> { CrossBreezeRestartAction.restart(project) }
    override fun install(statusBar: StatusBar) = Unit
    override fun dispose() = Unit
}
