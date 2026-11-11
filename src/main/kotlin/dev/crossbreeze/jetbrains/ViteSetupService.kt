package dev.crossbreeze.jetbrains

import com.google.gson.Gson
import com.google.gson.JsonParser
import com.intellij.diff.DiffContentFactory
import com.intellij.diff.DiffManager
import com.intellij.diff.requests.SimpleDiffRequest
import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.ide.plugins.PluginManagerCore
import com.intellij.ide.util.PropertiesComponent
import com.intellij.javascript.nodejs.interpreter.NodeJsInterpreterManager
import com.intellij.javascript.nodejs.interpreter.local.NodeJsLocalInterpreter
import com.intellij.notification.Notification
import com.intellij.notification.NotificationAction
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ReadAction
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.command.CommandProcessor
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.editor.EditorFactory
import com.intellij.openapi.editor.event.DocumentEvent
import com.intellij.openapi.editor.event.DocumentListener
import com.intellij.openapi.extensions.PluginId
import com.intellij.openapi.fileEditor.FileDocumentManager
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectFileIndex
import com.intellij.openapi.startup.ProjectActivity
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VFileProperty
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.openapi.vfs.VirtualFileManager
import com.intellij.openapi.vfs.newvfs.BulkFileListener
import com.intellij.openapi.vfs.newvfs.events.VFileEvent
import com.intellij.ui.EditorNotifications
import com.intellij.ui.components.JBScrollPane
import com.intellij.ui.components.JBTabbedPane
import com.intellij.ui.components.JBTextArea
import com.intellij.util.Alarm
import java.awt.BorderLayout
import java.awt.Dimension
import java.nio.charset.StandardCharsets.UTF_8
import java.nio.file.Path
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import javax.swing.JComponent
import javax.swing.JPanel

internal class ViteSetupStartup : ProjectActivity {
    override suspend fun execute(project: Project) {
        project.service<ViteSetupService>().refresh()
    }
}

@Service(Service.Level.PROJECT)
internal class ViteSetupService(private val project: Project) {
    internal data class Edit(val path: String, val before: String?, val after: String)
    internal data class Step(val message: String, val path: String)
    internal data class Plan(val edits: List<Edit>, val steps: List<Step>)
    private data class Input(val root: String, val files: Map<String, String>, val sources: List<String>)
    private data class Output(val root: String, val plan: Plan?)

    private val gson = Gson()
    private val alarm = Alarm(Alarm.ThreadToUse.POOLED_THREAD, project)
    private val revision = AtomicLong()
    private val offers = mutableMapOf<String, Pair<Plan, Notification>>()
    @Volatile private var packages: Set<String> = emptySet()

    init {
        ApplicationManager.getApplication().messageBus.connect(project).subscribe(VirtualFileManager.VFS_CHANGES, object : BulkFileListener {
            override fun after(events: List<VFileEvent>) {
                if (events.any { relevant(it.path) || it.path.substringAfterLast('.').lowercase() in sourceExtensions }) refresh()
            }
        })
        EditorFactory.getInstance().eventMulticaster.addDocumentListener(object : DocumentListener {
            override fun documentChanged(event: DocumentEvent) {
                val file = FileDocumentManager.getInstance().getFile(event.document) ?: return
                if (relevant(file.path)) refresh()
            }
        }, project)
    }

    private fun relevant(path: String): Boolean {
        val name = path.substringAfterLast('/')
        return name.startsWith("vite.config.") || name.endsWith(".json") || name.endsWith(".d.ts") ||
            name in setOf("node_modules", "@cross-css", "vite", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb")
    }

    fun refresh() {
        val scan = revision.incrementAndGet()
        alarm.cancelAllRequests()
        alarm.addRequest({
            val plans = if (project.service<CrossBreezeSettings>().state.enabled) inspect() else emptyMap()
            ApplicationManager.getApplication().invokeLater {
                if (!project.isDisposed && scan == revision.get()) publish(plans)
            }
        }, 350)
    }

    fun owns(file: VirtualFile): Boolean {
        val manifest = generateSequence(file.parent) { it.parent }
            .mapNotNull { it.findChild("package.json") }.firstOrNull() ?: return false
        return manifest.parent.path in packages ||
            looksLikeVite(manifest, FileDocumentManager.getInstance().getCachedDocument(manifest)?.text)
    }

    private fun inspect(onlyRoot: String? = null): Map<String, Plan> {
        if (project.isDisposed || !project.service<CrossBreezeSettings>().state.enabled) return emptyMap()
        val inputs = ReadAction.computeBlocking<List<Input>, RuntimeException> {
            val index = ProjectFileIndex.getInstance(project)
            val manifests = mutableMapOf<String, VirtualFile>()
            val sources = mutableListOf<VirtualFile>()
            index.iterateContent { file ->
                if (file.fileSystem.protocol == "file" && !file.isDirectory) {
                    if (file.name == "package.json" && !file.path.contains("/node_modules/")) manifests[file.parent.path] = file
                    if (file.extension in sourceExtensions && !file.name.endsWith(".d.ts")) sources.add(file)
                }
                true
            }
            val overlays = FileDocumentManager.getInstance().unsavedDocuments.mapNotNull { document ->
                val file = FileDocumentManager.getInstance().getFile(document) ?: return@mapNotNull null
                file.path to document.text
            }.toMap()
            val byPackage = sources.groupBy { file ->
                generateSequence(file.parent) { it.parent }.firstOrNull { it.path in manifests }?.path
            }
            manifests.filter { (root, file) ->
                (onlyRoot == null || root == onlyRoot) && looksLikeVite(file, overlays[file.path])
            }.keys.map { root ->
                Input(root, overlays, byPackage[root].orEmpty().map { it.path })
            }
        }
        if (inputs.isEmpty()) return emptyMap()
        val interpreter = NodeJsInterpreterManager.getInstance(project).interpreter as? NodeJsLocalInterpreter
            ?: return inputs.associate { input ->
                input.root to Plan(emptyList(), listOf(Step("Configure a local Node.js runtime in WebStorm to review XCSS setup.", input.root)))
            }
        val plugin = PluginManagerCore.getPlugin(PluginId.getId("dev.crossbreeze.jetbrains")) ?: return emptyMap()
        val script = plugin.pluginPath.resolve("server/vite-setup.cjs")
        val plans = runPlanner(interpreter, script, inputs)
        return plans.ifEmpty {
            inputs.associate { input ->
                input.root to Plan(emptyList(), listOf(Step("CrossBreeze could not read the Vite setup. Check the package and Vite configuration.", input.root + "/package.json")))
            }
        }
    }

    private fun looksLikeVite(file: VirtualFile, overlay: String?): Boolean {
        if (viteConfigExtensions.any { file.parent.findChild("vite.config.$it") != null }) return true
        return try {
            val manifest = JsonParser.parseString(overlay ?: VfsUtil.loadText(file)).asJsonObject
            listOf("dependencies", "devDependencies").any { manifest.get(it)?.takeIf { value -> value.isJsonObject }?.asJsonObject?.has("vite") == true } ||
                manifest.get("scripts")?.takeIf { it.isJsonObject }?.asJsonObject?.entrySet()?.any { (_, value) ->
                    value.isJsonPrimitive && value.asJsonPrimitive.isString && viteScript.containsMatchIn(value.asString.trim())
                } == true
        } catch (error: ProcessCanceledException) {
            throw error
        } catch (_: Exception) {
            false
        }
    }

    private fun runPlanner(interpreter: NodeJsLocalInterpreter, script: Path, inputs: List<Input>): Map<String, Plan> {
        return try {
            val process = GeneralCommandLine(interpreter.interpreterSystemDependentPath, script.toString())
                .withWorkDirectory(inputs.first().root).withCharset(UTF_8).createProcess()
            try {
                // Drain stdout while the process runs so a large diff cannot fill the pipe.
                val response = java.util.concurrent.CompletableFuture.supplyAsync {
                    process.inputStream.bufferedReader(UTF_8).use { it.readText() }
                }
                process.outputStream.bufferedWriter(UTF_8).use { gson.toJson(inputs, it) }
                if (!process.waitFor(10, TimeUnit.SECONDS) || process.exitValue() != 0) return emptyMap()
                gson.fromJson(response.get(1, TimeUnit.SECONDS), Array<Output>::class.java)
                    .mapNotNull { output -> output.plan?.let { output.root to it } }.toMap()
            } finally {
                if (process.isAlive) process.destroyForcibly()
            }
        } catch (error: ProcessCanceledException) {
            throw error
        } catch (error: Exception) {
            com.intellij.openapi.diagnostic.Logger.getInstance(ViteSetupService::class.java).debug("Could not inspect Vite setup", error)
            emptyMap()
        }
    }

    private fun dismissal(root: String) = "crossbreeze.vite.setup.dismissed.$root"

    private fun publish(plans: Map<String, Plan>) {
        if (packages != plans.keys) {
            packages = plans.keys
            EditorNotifications.getInstance(project).updateAllNotifications()
        }
        val properties = PropertiesComponent.getInstance(project)
        val actionable = plans.filter { (root, plan) -> plan.steps.isNotEmpty() && !properties.getBoolean(dismissal(root)) }
        for (root in offers.keys.toList()) {
            if (actionable[root] != offers[root]?.first) offers.remove(root)?.second?.expire()
        }
        for ((root, plan) in actionable) {
            if (root in offers) continue
            val name = Path.of(root).fileName?.toString() ?: root
            val notification = NotificationGroupManager.getInstance().getNotificationGroup("CrossBreeze")
                .createNotification("XCSS setup for $name", "Review the missing Vite and TypeScript setup steps.", NotificationType.INFORMATION)
            notification.addAction(NotificationAction.createSimple("Review setup") { review(root, plan) })
            notification.addAction(NotificationAction.createSimple("Don't show again") {
                properties.setValue(dismissal(root), true)
                offers.remove(root)?.second?.expire()
            })
            offers[root] = plan to notification
            notification.notify(project)
        }
    }

    private fun review(root: String, plan: Plan) {
        if (!SetupDialog(project, plan).showAndGet()) return
        val snapshot = revision.get()
        ApplicationManager.getApplication().executeOnPooledThread {
            val current = inspect(root)[root]
            ApplicationManager.getApplication().invokeLater {
                if (project.isDisposed) return@invokeLater
                if (current != plan || !apply(root, plan, snapshot)) {
                    Messages.showInfoMessage(project, "The setup inputs changed or a file could not be edited. Review the refreshed suggestion.", "XCSS Setup")
                }
                refresh()
            }
        }
    }

    internal fun apply(root: String, plan: Plan, expectedRevision: Long = revision.get()): Boolean {
        val directory = LocalFileSystem.getInstance().findFileByPath(root) ?: return false
        val documents = FileDocumentManager.getInstance()
        var applied = false
        WriteCommandAction.runWriteCommandAction(project, "Apply XCSS Vite setup", null, Runnable {
            if (revision.get() != expectedRevision || directory.`is`(VFileProperty.SYMLINK)) return@Runnable
            val base = Path.of(root).toAbsolutePath().normalize()
            val files = plan.edits.map { edit ->
                val target = Path.of(edit.path).toAbsolutePath().normalize()
                if (!target.startsWith(base) || target == base) return@Runnable
                val relative = base.relativize(target)
                val path = relative.toString().replace('\\', '/')
                val parent = path.substringBeforeLast('/', "").let {
                    if (it.isEmpty()) directory else directory.findFileByRelativePath(it)
                } ?: return@Runnable
                if (!parent.isWritable || !ProjectFileIndex.getInstance(project).isInContent(parent) ||
                    generateSequence(parent) { it.parent }.takeWhile { it != directory }.any { it.`is`(VFileProperty.SYMLINK) }
                ) return@Runnable
                val name = path.substringAfterLast('/')
                val file = parent.findChild(name)
                if (file?.`is`(VFileProperty.SYMLINK) == true || file?.isWritable == false || file?.isDirectory == true) return@Runnable
                val document = file?.let(documents::getDocument)
                if ((file != null && document == null) || document?.text != edit.before?.replace("\r\n", "\n")) return@Runnable
                Triple(edit, parent, document)
            }
            val created = mutableListOf<VirtualFile>()
            val changed = mutableListOf<Pair<com.intellij.openapi.editor.Document, String>>()
            try {
                CommandProcessor.getInstance().markCurrentCommandAsGlobal(project)
                for ((edit, parent, document) in files) {
                    if (document == null) {
                        val file = parent.createChildData(this, Path.of(edit.path).fileName.toString())
                        created.add(file)
                        VfsUtil.saveText(file, edit.after)
                    } else {
                        changed.add(document to document.text)
                        document.setText(edit.after.replace("\r\n", "\n"))
                    }
                }
                applied = true
            } catch (error: Exception) {
                changed.asReversed().forEach { (document, text) -> document.setText(text) }
                created.asReversed().forEach { it.delete(this) }
                com.intellij.openapi.diagnostic.Logger.getInstance(ViteSetupService::class.java).warn("Could not apply XCSS setup", error)
            }
        })
        return applied
    }

    private companion object {
        val sourceExtensions = setOf("ts", "tsx", "mts", "cts")
        val viteConfigExtensions = setOf("ts", "js", "mts", "mjs", "cts", "cjs")
        val viteScript = Regex("^vite(?:\\s|$)")
    }
}

private class SetupDialog(private val project: Project, private val plan: ViteSetupService.Plan) : DialogWrapper(project) {
    init {
        title = "Review XCSS Setup"
        setOKButtonText(if (plan.edits.isEmpty()) "Close" else "Apply")
        init()
    }

    override fun createCenterPanel(): JComponent {
        val summary = JBTextArea(plan.steps.joinToString("\n\n") { it.message + "\n" + it.path }).apply {
            isEditable = false
            lineWrap = true
            wrapStyleWord = true
            rows = 5
        }
        return JPanel(BorderLayout()).apply {
            preferredSize = Dimension(760, if (plan.edits.isEmpty()) 220 else 500)
            add(JBScrollPane(summary), if (plan.edits.isEmpty()) BorderLayout.CENTER else BorderLayout.NORTH)
            if (plan.edits.isNotEmpty()) {
                val tabs = JBTabbedPane()
                val factory = DiffContentFactory.getInstance()
                for (edit in plan.edits) {
                    val diff = DiffManager.getInstance().createRequestPanel(project, disposable, null)
                    val name = Path.of(edit.path).fileName.toString()
                    diff.setRequest(SimpleDiffRequest(name, factory.create(project, edit.before.orEmpty()), factory.create(project, edit.after), "Current", "Proposed"))
                    tabs.addTab(name, diff.component)
                }
                add(tabs, BorderLayout.CENTER)
            }
        }
    }

    override fun doOKAction() {
        if (plan.edits.isEmpty()) close(CANCEL_EXIT_CODE) else super.doOKAction()
    }
}

