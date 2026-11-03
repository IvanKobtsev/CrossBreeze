package dev.crossbreeze.jetbrains

import com.intellij.execution.ExecutionException
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.javascript.nodejs.interpreter.NodeJsInterpreterManager
import com.intellij.javascript.nodejs.interpreter.local.NodeJsLocalInterpreter
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.extensions.PluginAware
import com.intellij.openapi.extensions.PluginDescriptor
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectRootManager
import com.intellij.openapi.util.Key
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.platform.lsp.api.LspClientManager
import com.intellij.platform.lsp.api.LspIntegrationProvider
import com.intellij.platform.lsp.api.LspServerListener
import com.intellij.platform.lsp.api.ProjectWideLspClientDescriptor
import com.intellij.platform.lsp.api.customization.LspCustomization
import com.intellij.platform.lsp.api.customization.LspSemanticTokensSupport
import com.intellij.platform.lsp.api.customization.LspDocumentColorDisabled
import com.intellij.platform.lsp.api.customization.LspFormattingSupport
import com.intellij.application.options.CodeStyle
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.fileEditor.FileDocumentManager
import org.eclipse.lsp4j.ConfigurationItem
import org.eclipse.lsp4j.InitializeResult
import org.eclipse.lsp4j.WorkspaceFolder
import java.nio.file.Files
import java.nio.file.Path

class CrossBreezeLspIntegrationProvider : LspIntegrationProvider, PluginAware {
    private lateinit var pluginRoot: Path
    override fun setPluginDescriptor(pluginDescriptor: PluginDescriptor) { pluginRoot = pluginDescriptor.pluginPath }
    internal fun descriptorFor(project: Project): CrossBreezeDescriptor = project.getUserData(KEY) ?: synchronized(project) {
        project.getUserData(KEY) ?: CrossBreezeDescriptor(project, pluginRoot).also { project.putUserData(KEY, it) }
    }
    override fun fileOpened(project: Project, file: VirtualFile, clientStarter: LspIntegrationProvider.LspClientStarter) {
        if (file.extension != "xcss" || !project.service<CrossBreezeSettings>().state.enabled) return
        clientStarter.ensureClientStarted(descriptorFor(project))
    }
    companion object { private val KEY = Key.create<CrossBreezeDescriptor>("CrossBreeze.descriptor") }
}
internal class CrossBreezeDescriptor(project: Project, private val root: Path) : ProjectWideLspClientDescriptor(project, "CrossBreeze") {
    override fun isSupportedFile(file: VirtualFile) = file.extension == "xcss" && project.service<CrossBreezeSettings>().state.enabled
    override fun getLanguageId(file: VirtualFile) = "xcss"
    override fun createCommandLine(): GeneralCommandLine {
        val interpreter = NodeJsInterpreterManager.getInstance(project).interpreter
        val local = interpreter as? NodeJsLocalInterpreter ?: throw unavailable("Configure a local Node.js runtime in Languages & Frameworks → JavaScript Runtime. Remote, WSL, and Docker runtimes are not supported yet.")
        val server = root.resolve("server/index.cjs")
        if (!Files.isRegularFile(server)) throw unavailable("The bundled language server is missing. Reinstall CrossBreeze.")
        project.service<CrossBreezeRuntime>().status = "Starting"
        return GeneralCommandLine(local.interpreterSystemDependentPath, server.toString())
            .withWorkDirectory(project.basePath ?: root.toString())
            .withCharset(Charsets.UTF_8)
    }
    private fun unavailable(message: String): ExecutionException {
        project.service<CrossBreezeRuntime>().status = "Unavailable"
        NotificationGroupManager.getInstance().getNotificationGroup("CrossBreeze")
            .createNotification("CrossBreeze could not start", message, NotificationType.WARNING).notify(project)
        return ExecutionException(message)
    }
    override fun createInitializationOptions(): Any = mapOf(
        "aliases" to project.service<CrossBreezeSettings>().aliases(),
        "checkCssProperties" to project.service<CrossBreezeSettings>().state.checkCssProperties,
        "checkCssValues" to project.service<CrossBreezeSettings>().state.checkCssValues,
        "excludedRoots" to ProjectRootManager.getInstance(project).contentSourceRoots.let {
            com.intellij.openapi.module.ModuleManager.getInstance(project).modules.flatMap { module ->
                com.intellij.openapi.roots.ModuleRootManager.getInstance(module).excludeRoots.map { it.path }
            }
        },
    )
    override fun createInitializeParams() = super.createInitializeParams().apply {
        workspaceFolders = ProjectRootManager.getInstance(project).contentRoots.filter { it.fileSystem.protocol == "file" }
            .map { WorkspaceFolder(it.toNioPath().toUri().toString(), it.name) }
    }
    override fun getWorkspaceConfiguration(item: ConfigurationItem): Any? {
        if (item.section != "crossbreeze.formatting") return null
        return ReadAction.computeBlocking<Any?, RuntimeException> {
            val file = item.scopeUri?.let { findFileByUri(it) } ?: return@computeBlocking null
            if (file.extension != "xcss") return@computeBlocking null
            val settings = CodeStyle.getSettings(project, file)
            val indent = CodeStyle.getIndentOptions(project, file)
            val separator = settings.lineSeparator ?: FileDocumentManager.getInstance().getLineSeparator(file, project)
            mapOf(
                "tabWidth" to if (indent.USE_TAB_CHARACTER) indent.TAB_SIZE else indent.INDENT_SIZE,
                "useTabs" to indent.USE_TAB_CHARACTER,
                "printWidth" to settings.getRightMargin(XcssLanguage),
                "endOfLine" to if (separator == "\r\n") "crlf" else "lf",
            )
        }
    }
    override val lspCustomization = object : LspCustomization() {
        // Editable ElementColorProvider icons replace the passive LSP inlays.
        override val documentColorCustomizer = LspDocumentColorDisabled
        override val formattingCustomizer = object : LspFormattingSupport() {
            override fun shouldFormatThisFileExclusivelyByServer(file: VirtualFile, ideCanFormatThisFileItself: Boolean, serverExplicitlyWantsToFormatThisFile: Boolean) = file.extension == "xcss"
        }
        override val semanticTokensCustomizer = object : LspSemanticTokensSupport() {
            override fun shouldAskServerForSemanticTokens(psiFile: com.intellij.psi.PsiFile) = psiFile.language == XcssLanguage
            override val tokenTypes = XcssColors.semantic.keys.toList()
            override val tokenModifiers = listOf("declaration")
            override fun getTextAttributesKey(tokenType: String, modifiers: List<String>) = XcssColors.semantic[tokenType]
        }
    }
    override val lspServerListener = object : LspServerListener {
        override fun serverInitialized(params: InitializeResult) { project.service<CrossBreezeRuntime>().status = "Ready" }
        override fun serverStopped(shutdownNormally: Boolean) {
            val runtime = project.service<CrossBreezeRuntime>()
            runtime.status = "Stopped"
            if (!shutdownNormally && runtime.retry()) ApplicationManager.getApplication().invokeLater {
                if (!project.isDisposed) LspClientManager.getInstance(project).startClientsIfNeeded(CrossBreezeLspIntegrationProvider::class.java)
            }
        }
    }
}
@Service(Service.Level.PROJECT)
class CrossBreezeRuntime(private val project: Project) {
    @Volatile var status: String = "Idle"
        set(value) {
            field = value
            ApplicationManager.getApplication().invokeLater {
                if (!project.isDisposed) com.intellij.openapi.wm.WindowManager.getInstance().getStatusBar(project)?.updateWidget("CrossBreeze")
            }
        }
    private val failures = ArrayDeque<Long>()
    @Synchronized fun retry(): Boolean {
        val now = System.currentTimeMillis()
        while (failures.isNotEmpty() && failures.first() < now - 60_000) failures.removeFirst()
        failures.addLast(now)
        return failures.size <= 3
    }
    @Synchronized fun reset() { failures.clear(); status = "Starting" }
}
