package dev.crossbreeze.jetbrains

import com.intellij.ide.util.PropertiesComponent
import com.intellij.lang.typescript.tsconfig.TypeScriptConfig
import com.intellij.lang.typescript.tsconfig.TypeScriptConfigService
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.components.service
import com.intellij.openapi.components.Service
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.fileEditor.FileEditor
import com.intellij.openapi.fileEditor.FileEditorManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.ui.EditorNotificationPanel
import com.intellij.ui.EditorNotificationProvider
import com.intellij.ui.EditorNotifications
import com.intellij.psi.search.FilenameIndex
import com.intellij.psi.search.GlobalSearchScope
import com.intellij.util.Alarm
import java.util.function.Function
import javax.swing.JComponent

/** Offers a project declaration only; the language server never creates project files. */
class XcssTypescriptSetupNotification : EditorNotificationProvider {
    override fun collectNotificationData(project: Project, file: VirtualFile): Function<FileEditor, JComponent>? {
        project.service<XcssTypescriptSetupRefresh>()
        val plan = XcssTypescriptSetup.plan(project, file) ?: return null
        return Function { editor ->
            EditorNotificationPanel(editor, EditorNotificationPanel.Status.Info).apply {
                if (plan.existing == null) {
                    text = "TypeScript needs declarations to recognize XCSS imports."
                    createActionLabel("Add declarations", Runnable {
                        val created = XcssTypescriptSetup.create(project, plan)
                        EditorNotifications.getInstance(project).updateAllNotifications()
                        created?.let { FileEditorManager.getInstance(project).openFile(it, true) }
                    })
                } else {
                    text = "Include ${plan.name} in ${plan.config.configFile.name} to enable XCSS imports."
                    createActionLabel("Open TypeScript configuration", Runnable {
                        FileEditorManager.getInstance(project).openFile(plan.config.configFile, true)
                    })
                }
                createActionLabel("Don't show again", Runnable {
                    XcssTypescriptSetup.dismiss(project, plan)
                    EditorNotifications.getInstance(project).updateAllNotifications()
                })
            }
        }
    }
}

@Service(Service.Level.PROJECT)
internal class XcssTypescriptSetupRefresh(private val project: Project) {
    private val alarm = Alarm(Alarm.ThreadToUse.SWING_THREAD, project)
    init {
        ApplicationManager.getApplication().messageBus.connect(project).subscribe(VirtualFileManager.VFS_CHANGES, object : BulkFileListener {
            override fun after(events: List<VFileEvent>) {
                if (events.any { relevant(it.path.substringAfterLast('/')) }) refresh()
            }
        })
        EditorFactory.getInstance().eventMulticaster.addDocumentListener(object : DocumentListener {
            override fun documentChanged(event: DocumentEvent) {
                val file = FileDocumentManager.getInstance().getFile(event.document) ?: return
                if (relevant(file.name)) refresh()
                else if (file.extension in setOf("ts", "tsx", "mts", "cts")) EditorNotifications.getInstance(project).updateNotifications(file)
            }
        }, project)
    }
    private fun relevant(name: String) = name.endsWith(".d.ts") || name.endsWith(".json")
    private fun refresh() {
        alarm.cancelAllRequests()
        alarm.addRequest({ if (!project.isDisposed) EditorNotifications.getInstance(project).updateAllNotifications() }, 200)
    }
}

internal object XcssTypescriptSetup {
    const val CLIENT = "@cross-css/vite/client"
    private val clients = listOf(CLIENT, "@cross-css/vite-plugin/client")
    const val CONTENT = "/// <reference types=\"$CLIENT\" />\n"
    data class Plan(val config: TypeScriptConfig, val directory: VirtualFile, val name: String, val client: String, val existing: VirtualFile? = null) {
        val content get() = "/// <reference types=\"$client\" />\n"
        val dismissalKey get() = "crossbreeze.typescript.setup.dismissed.${config.configFile.url}"
    }
    private val clientReference = Regex("""(?m)^\s*///\s*<reference\s+types\s*=\s*["'](@cross-css/vite(?:-plugin)?/client)["']""")
    private val clientImport = Regex("""\bimport\s*["'](@cross-css/vite(?:-plugin)?/client)["']""")
    private val moduleDeclaration = Regex("""\bdeclare\s+module\s*["']\*\.xcss["']""")
    private val xcssImport = Regex("""\b(?:from\s*|import\s*(?:\(\s*)?)["'][^"'\r\n]+\.xcss["']""")

    fun plan(project: Project, file: VirtualFile): Plan? {
        if (!file.isValid || file.isDirectory || !project.service<CrossBreezeSettings>().state.enabled) return null
        val index = ProjectFileIndex.getInstance(project)
        if (!index.isInContent(file) || index.isExcluded(file)) return null
        if (file.extension != "xcss" && (file.extension !in setOf("ts", "tsx", "mts", "cts") || !xcssImport.containsMatchIn(text(file)))) return null
        val configs = project.service<TypeScriptConfigService>()
        val config = configs.getPreferableOrParentConfig(file) ?: return null
        if (config.isJSConfig || config.hasErrors()) return null
        val root = config.configFile.parent ?: return null
        val directory = config.rootDirFile?.takeIf { it.isDirectory && VfsUtil.isAncestor(root, it, false) }
            ?: root.findChild("src")?.takeIf { it.isDirectory }
            ?: root
        val availableClients = findClients(root)
        val client = availableClients.firstOrNull() ?: return null
        val names = listOf("xcss-env.d.ts", "crossbreeze-xcss-env.d.ts")
        val existing = names.mapNotNull { directory.findChild(it) }.firstOrNull { !it.isDirectory && declaresXcss(text(it), availableClients) }
        val name = existing?.name ?: names.firstOrNull { directory.findChild(it) == null } ?: return null
        val plan = Plan(config, directory, name, client, existing)
        if (PropertiesComponent.getInstance(project).getBoolean(plan.dismissalKey)) return null
        if (!directory.isWritable || configured(project, config, directory, availableClients)) return null
        return plan
    }

    private fun configured(project: Project, config: TypeScriptConfig, directory: VirtualFile, availableClients: List<String>): Boolean {
        if (config.types.any { it in availableClients }) return true
        val candidates = FilenameIndex.getAllFilesByExt(project, "ts", GlobalSearchScope.projectScope(project)) + directory.children.toList()
        return candidates.any { file ->
            !file.isDirectory && file.name.endsWith(".d.ts") && config.isIncludedFile(file, false) && declaresXcss(text(file), availableClients)
        }
    }

    internal fun declaresXcss(source: String, availableClients: List<String> = clients): Boolean =
        moduleDeclaration.containsMatchIn(source) ||
            clientReference.findAll(source).any { it.groupValues[1] in availableClients } ||
            clientImport.findAll(source).any { it.groupValues[1] in availableClients }

    private fun findClients(root: VirtualFile): List<String> {
        val available = linkedSetOf<String>()
        var directory: VirtualFile? = root
        while (directory != null) {
            val current = directory
            available += clients.filter { current.findFileByRelativePath("node_modules/$it.d.ts") != null }
            directory = current.parent
        }
        return available.toList()
    }

    private fun text(file: VirtualFile): String = FileDocumentManager.getInstance().getCachedDocument(file)?.text
        ?: VfsUtil.loadText(file)

    fun create(project: Project, plan: Plan): VirtualFile? {
        if (plan.existing != null) return null
        var created: VirtualFile? = null
        WriteCommandAction.runWriteCommandAction(project, "Add XCSS TypeScript declarations", null, Runnable {
            if (!plan.directory.isValid || plan.directory.findChild(plan.name) != null) return@Runnable
            created = plan.directory.createChildData(this, plan.name).also { VfsUtil.saveText(it, plan.content) }
        })
        return created
    }

    fun dismiss(project: Project, plan: Plan) {
        PropertiesComponent.getInstance(project).setValue(plan.dismissalKey, true)
    }
}
