package dev.crossbreeze.jetbrains

import com.google.gson.*
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.*
import com.intellij.ide.plugins.cl.PluginAwareClassLoader
import com.intellij.openapi.fileChooser.*
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.wm.*
import com.intellij.ui.components.*
import com.intellij.ui.content.ContentFactory
import com.intellij.util.ui.JBUI
import com.sun.net.httpserver.HttpServer
import java.net.InetSocketAddress
import java.nio.file.*
import javax.swing.*
import javax.swing.table.DefaultTableModel
import java.awt.BorderLayout

internal const val SNAPSHOT_LIMIT = 32 * 1024 * 1024
internal fun parseSnapshot(bytes: ByteArray): JsonObject {
    require(bytes.size <= SNAPSHOT_LIMIT) { "Snapshot exceeds 32 MiB" }
    val doc = JsonParser.parseString(bytes.toString(Charsets.UTF_8)).asJsonObject
    require(doc["format"]?.asString == "crossfigma.snapshot" && doc["version"]?.asInt == 1) { "Expected crossfigma.snapshot version 1" }
    for (key in listOf("collections", "variables")) require(doc[key]?.isJsonArray == true) { "Missing $key" }
    require(doc["styles"]?.isJsonObject == true) { "Missing styles" }
    for (collection in doc.getAsJsonArray("collections")) {
        val c = collection.asJsonObject
        require(c["id"]?.isJsonPrimitive == true && c["name"]?.isJsonPrimitive == true && c["defaultModeId"]?.isJsonPrimitive == true) { "Invalid collection identity" }
        require(c["modes"]?.isJsonArray == true) { "Missing collection modes" }
        for (mode in c.getAsJsonArray("modes")) require(mode.asJsonObject["modeId"]?.isJsonPrimitive == true && mode.asJsonObject["name"]?.isJsonPrimitive == true) { "Invalid mode" }
    }
    for (key in listOf("text", "paint", "effect", "grid")) require(doc.getAsJsonObject("styles")[key]?.isJsonArray == true) { "Missing styles.$key" }
    return doc
}

@State(name = "CrossBreezeImport", storages = [Storage(StoragePathMacros.WORKSPACE_FILE)])
@Service(Service.Level.PROJECT)
internal class CrossBreezeImportState : PersistentStateComponent<CrossBreezeImportState.Data> {
    class Data { var snapshots = mutableMapOf<String, String>(); var generated = mutableListOf<String>(); var target = "" }
    private var data = Data()
    override fun getState() = data
    override fun loadState(state: Data) { data = state }
}

/** One explicit receiving destination across all open projects. */
internal object SnapshotReceiver {
    private var servers = emptyList<HttpServer>()
    private var owner: Any? = null
    @Synchronized fun stop(token: Any) { if (owner === token) { servers.forEach { it.stop(0) }; servers = emptyList(); owner = null } }
    @Synchronized fun start(token: Any, accept: (ByteArray) -> Unit) {
        check(owner == null) { "Another project is already waiting for CrossFigma" }
        val opened = mutableListOf<HttpServer>()
        try {
            for (host in listOf("127.0.0.1", "::1")) {
                val server = HttpServer.create(InetSocketAddress(host, 38473), 0)
                opened.add(server)
                server.createContext("/") { exchange ->
                    var status = 200
                    var body = ""
                    var accepted = false
                    try {
                        when {
                            exchange.requestMethod == "OPTIONS" -> status = 204
                            exchange.requestMethod == "GET" && exchange.requestURI.path == "/health" -> body = "{\"service\":\"CrossBreeze\",\"protocolVersion\":1}"
                            exchange.requestMethod == "POST" && exchange.requestURI.path == "/design-tokens" -> {
                                require(exchange.requestHeaders.getFirst("Content-Type")?.substringBefore(';')?.trim()?.equals("application/json", true) == true) { "Expected application/json" }
                                val bytes = exchange.requestBody.readNBytes(SNAPSHOT_LIMIT + 1)
                                if (bytes.size > SNAPSHOT_LIMIT) { status = 413; throw IllegalArgumentException("Snapshot exceeds 32 MiB") }
                                parseSnapshot(bytes)
                                accept(bytes)
                                body = "Snapshot accepted; configure generation in CrossBreeze"
                                accepted = true
                            }
                            else -> { status = 404; body = "Not found" }
                        }
                    } catch (e: Exception) { if (status == 200) status = 400; body = e.message ?: "Invalid snapshot" }
                    exchange.responseHeaders.apply {
                        set("Access-Control-Allow-Origin", "*"); set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
                        set("Access-Control-Allow-Headers", "Content-Type"); set("Access-Control-Allow-Private-Network", "true")
                        set("Content-Type", if (exchange.requestURI.path == "/health") "application/json" else "text/plain; charset=utf-8")
                    }
                    val response = body.toByteArray(Charsets.UTF_8)
                    exchange.sendResponseHeaders(status, if (status == 204) -1 else response.size.toLong())
                    exchange.responseBody.use { if (status != 204) it.write(response) }
                    exchange.close()
                    if (accepted) Thread.ofVirtual().start { stop(token) }
                }
                server.start()
            }
            servers = opened; owner = token
        } catch (e: Exception) { opened.forEach { it.stop(0) }; throw IllegalStateException("Cannot listen on localhost:38473: ${e.message}", e) }
    }
}

class CrossBreezeToolWindowFactory : ToolWindowFactory {
    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val pluginRoot = requireNotNull(javaClass.classLoader as? PluginAwareClassLoader) {
            "CrossBreeze plugin descriptor is unavailable"
        }.pluginDescriptor.pluginPath
        val panel = CrossBreezeImportPanel(project, pluginRoot)
        toolWindow.contentManager.addContent(ContentFactory.getInstance().createContent(panel.component, "", false).apply { setDisposer(panel) })
    }
}

internal class CrossBreezeImportPanel(private val project: Project, private val pluginRoot: Path) : Disposable {
    val component = JPanel(BorderLayout())
    private val state = project.service<CrossBreezeImportState>().state
    private var root = Path.of(state.target.ifBlank { project.basePath ?: "." }).toAbsolutePath().normalize()
    private var snapshot: JsonObject? = null
    private var original: String? = null
    private var document = JsonObject()
    private val content = JPanel().apply { layout = BoxLayout(this, BoxLayout.Y_AXIS); border = JBUI.Borders.empty(12) }
    private val status = JBLabel(" ")
    private val diagnostics = JBTextArea().apply { isEditable = false; lineWrap = true; wrapStyleWord = true; rows = 5 }
    private val output = JBTextField("src/styles/generated")
    private val themes = DefaultTableModel(arrayOf("Theme", "Collection", "Mode"), 0)
    private val screens = DefaultTableModel(arrayOf("Screen", "Media query", "Collection", "Mode"), 0)
    private val units = DefaultTableModel(arrayOf("Match (exact/prefix)", "Token name/prefix", "Unit"), 0)
    private val tables = mutableListOf<JTable>()
    private val generate = JButton("Generate XCSS")
    @Volatile private var disposed = false
    @Volatile private var process: Process? = null
    init {
        component.add(JBScrollPane(content), BorderLayout.CENTER)
        component.add(JPanel(BorderLayout()).apply { add(status, BorderLayout.NORTH); add(JBScrollPane(diagnostics), BorderLayout.CENTER) }, BorderLayout.SOUTH)
        render()
    }
    private fun button(label: String, action: () -> Unit) = JButton(label).apply { addActionListener { attempt(action) } }
    private fun attempt(action: () -> Unit) { try { action() } catch (e: Exception) { status.text = e.message ?: "Operation failed" } }
    private fun render() {
        content.removeAll(); tables.clear()
        content.add(JBLabel("Target: $root"))
        content.add(button("Choose project/package directory") {
            if (!discard()) return@button
            FileChooser.chooseFile(FileChooserDescriptorFactory.createSingleFolderDescriptor(), project, null)?.let {
                SnapshotReceiver.stop(this); root = it.toNioPath(); state.target = root.toString(); snapshot = null; render()
            }
        })
        content.add(button("Import tokens with CrossFigma directly") {
            if (!discard()) return@button
            SnapshotReceiver.start(this) { bytes ->
                val parsed = parseSnapshot(bytes)
                ApplicationManager.getApplication().invokeAndWait { check(!disposed) { "Destination project closed" }; accept(parsed) }
            }
            status.text = "Waiting: run CrossFigma’s Send design tokens to CrossBreeze action."
        })
        content.add(button("Cancel waiting") { SnapshotReceiver.stop(this); status.text = "Waiting cancelled" })
        content.add(button("Import tokens from CrossFigma snapshot JSON") {
            if (!discard()) return@button
            FileChooser.chooseFile(FileChooserDescriptorFactory.createSingleFileDescriptor("json"), project, null)?.let {
                require(it.length <= SNAPSHOT_LIMIT) { "Snapshot exceeds 32 MiB" }
                SnapshotReceiver.stop(this)
                accept(parseSnapshot(it.contentsToByteArray()))
            }
        })
        snapshot = snapshot ?: state.snapshots[root.toString()]?.let { runCatching { parseSnapshot(it.toByteArray()) }.getOrNull() }
        content.add(button("Open XCSS config in editor") { LocalFileSystem.getInstance().refreshAndFindFileByNioFile(configPath())?.let { com.intellij.openapi.fileEditor.FileEditorManager.getInstance(project).openFile(it, true) } })
        content.add(button("Reload configuration") { if (discard()) render() })
        snapshot?.let { doc ->
            content.add(JBLabel("${doc.getAsJsonArray("collections").size()} collections · ${doc.getAsJsonArray("variables").size()} variables"))
            content.add(JBLabel("Collections and modes:"))
            for (collection in doc.getAsJsonArray("collections")) {
                val c = collection.asJsonObject
                content.add(JBLabel("${c["name"].asString}: " + c.getAsJsonArray("modes").joinToString { it.asJsonObject["name"].asString }))
            }
            try { loadConfig() } catch (e: Exception) { status.text = "Invalid XCSS config: ${e.message}. Open it in the editor, fix it, then reload."; content.revalidate(); content.repaint(); return }
            content.add(JBLabel("Output directory")); content.add(output)
            table("Themes (one row per collection mapping)", themes)
            table("Screens (one row per collection mapping)", screens)
            table("Units", units)
            content.add(button(if (original == null) "Create XCSS config" else "Save config") { save(); status.text = "Configuration saved" })
            val previous = root.toString() in state.generated || generatedFilesExist()
            generate.text = if (previous) "Update XCSS" else "Generate XCSS"
            generate.isEnabled = true
            generate.toolTipText = if (previous) "Update generated tokens and XCSS references using the previous import baseline" else null
            generate.actionListeners.forEach { generate.removeActionListener(it) }
            generate.addActionListener { attempt { save(); runGeneration() } }
            content.add(generate)

        }
        content.revalidate(); content.repaint()
    }
    private fun discard(): Boolean = snapshot == null || Messages.showYesNoDialog(project, "Discard unsaved configuration edits?", "CrossBreeze", Messages.getQuestionIcon()) == Messages.YES
    private fun accept(doc: JsonObject) {
        snapshot = doc; state.snapshots[root.toString()] = doc.toString(); state.target = root.toString()
        render(); status.text = "Snapshot imported. Review configuration before generation."
    }
    private fun table(title: String, model: DefaultTableModel) {
        content.add(JBLabel(title))
        val table = JTable(model); tables.add(table)
        if (model !== units) {
            val names = snapshot!!.getAsJsonArray("collections").map { it.asJsonObject["name"].asString }.distinct()
            table.columnModel.getColumn(if (model === themes) 1 else 2).cellEditor = DefaultCellEditor(JComboBox(names.toTypedArray()))
            val modes = snapshot!!.getAsJsonArray("collections").flatMap { it.asJsonObject.getAsJsonArray("modes").map { m -> m.asJsonObject["name"].asString } }.distinct()
            table.columnModel.getColumn(if (model === themes) 2 else 3).cellEditor = DefaultCellEditor(JComboBox(modes.toTypedArray()))
        }
        content.add(JBScrollPane(table).apply { preferredSize = java.awt.Dimension(350, 110) })
        content.add(JPanel().apply {
            add(button("Add row") { model.addRow(Array(model.columnCount) { "" }) })
            add(button("Remove row") { if (table.selectedRow >= 0) model.removeRow(table.selectedRow) })
        })
    }
    private fun configPath() = root.resolve("xcss.config.json")
    private fun loadConfig() {
        original = if (Files.exists(configPath())) Files.readString(configPath()) else null
        document = original?.let { JsonParser.parseString(it).asJsonObject } ?: JsonObject()
        val cfg = document.getAsJsonObject("cross-figma") ?: JsonObject()
        output.text = cfg["output"]?.asString ?: "src/styles/generated"
        themes.rowCount = 0; screens.rowCount = 0; units.rowCount = 0
        for ((key, value) in cfg.getAsJsonObject("themes")?.entrySet().orEmpty()) {
            val mappings = value.asJsonObject.getAsJsonObject("modes")?.entrySet().orEmpty()
            if (mappings.isEmpty()) themes.addRow(arrayOf(key, "", ""))
            else for ((c, m) in mappings) themes.addRow(arrayOf(key, c, m.asString))
        }
        for ((key, value) in cfg.getAsJsonObject("screens")?.entrySet().orEmpty()) {
            val v = value.asJsonObject
            val mappings = v.getAsJsonObject("modes")?.entrySet().orEmpty()
            if (mappings.isEmpty()) screens.addRow(arrayOf(key, v["media"]?.asString ?: "", "", ""))
            else for ((c, m) in mappings) screens.addRow(arrayOf(key, v["media"]?.asString ?: "", c, m.asString))
        }
        for (kind in listOf("exact", "prefix")) for ((k, v) in cfg.getAsJsonObject("units")?.getAsJsonObject(kind)?.entrySet().orEmpty()) units.addRow(arrayOf(kind, k, v.asString))
    }
    private fun configuration(): JsonObject {
        tables.forEach { if (it.isEditing) it.cellEditor.stopCellEditing() }
        require(output.text.isNotBlank()) { "Output directory is required" }
        val cfg = document.getAsJsonObject("cross-figma")?.deepCopy() ?: JsonObject()
        cfg.addProperty("output", output.text.trim())
        for ((kind, model) in listOf("themes" to themes, "screens" to screens)) {
            val result = JsonObject()
            for (row in 0 until model.rowCount) {
                fun cell(col: Int) = model.getValueAt(row, col)?.toString()?.trim().orEmpty()
                val key = cell(0); require(key.isNotEmpty()) { "$kind name is required" }
                val item = result.getAsJsonObject(key) ?: JsonObject().also { result.add(key, it); it.add("modes", JsonObject()) }
                val offset = if (kind == "screens") 1 else 0
                if (offset == 1) {
                    require(cell(1).isNotEmpty()) { "Media query is required" }
                    require(item["media"] == null || item["media"].asString == cell(1)) { "Conflicting media queries for $key" }
                    item.addProperty("media", cell(1))
                }
                val collection = cell(1 + offset); val mode = cell(2 + offset)
                if (collection.isNotEmpty() || mode.isNotEmpty()) {
                    val matches = snapshot!!.getAsJsonArray("collections").filter { it.asJsonObject["name"].asString == collection }
                    require(matches.size == 1) { "Missing or ambiguous collection: $collection" }
                    require(matches.single().asJsonObject.getAsJsonArray("modes").count { it.asJsonObject["name"].asString == mode } == 1) { "Missing or ambiguous mode: $collection/$mode" }
                    require(!item.getAsJsonObject("modes").has(collection)) { "Duplicate collection mapping: $key/$collection" }
                    item.getAsJsonObject("modes").addProperty(collection, mode)
                }
            }
            cfg.add(kind, result)
        }
        val u = JsonObject().apply { add("exact", JsonObject()); add("prefix", JsonObject()) }
        for (row in 0 until units.rowCount) {
            val kind = units.getValueAt(row, 0)?.toString().orEmpty()
            require(kind in listOf("exact", "prefix")) { "Unit match must be exact or prefix" }
            val key = units.getValueAt(row, 1)?.toString().orEmpty()
            require(key.isNotEmpty() && !u.getAsJsonObject(kind).has(key)) { "Empty or duplicate unit mapping" }
            val unit = units.getValueAt(row, 2)?.toString().orEmpty()
            require(unit.all { it in 'a'..'z' || it in 'A'..'Z' || it == '%' }) { "Invalid unit: $unit" }
            u.getAsJsonObject(kind).addProperty(key, unit)
        }
        cfg.add("units", u); return cfg
    }
    private fun save() {
        val cfg = configuration()
        val virtualFile = LocalFileSystem.getInstance().refreshAndFindFileByNioFile(configPath())
        val documents = com.intellij.openapi.fileEditor.FileDocumentManager.getInstance()
        require(virtualFile == null || documents.getCachedDocument(virtualFile)?.let { !documents.isDocumentUnsaved(it) } != false) { "Save configuration edits in the editor, then reload configuration." }
        val current = if (Files.exists(configPath())) Files.readString(configPath()) else null
        require(current == original) { "Configuration changed externally. Reimport the snapshot to reload it." }
        document.add("cross-figma", cfg)
        val text = GsonBuilder().setPrettyPrinting().create().toJson(document) + "\n"
        Files.writeString(configPath(), text); original = text
        LocalFileSystem.getInstance().refreshAndFindFileByNioFile(configPath())
    }
    private fun generatedFilesExist(): Boolean {
        val directory = root.resolve(output.text)
        return Files.isDirectory(directory) && Files.list(directory).use { files -> files.anyMatch { it.fileName.toString().endsWith(".xcss") } }
    }
    private fun runGeneration() {
        com.intellij.openapi.fileEditor.FileDocumentManager.getInstance().saveAllDocuments()
        val updating = generatedFilesExist() || root.toString() in state.generated
        require(!updating || Files.isRegularFile(root.resolve(output.text).resolve(".cross-figma.json"))) { "Update needs a baseline from CLI 0.14.1. Import the previous snapshot with CLI 0.14.1 first, then retry." }
        val binary = pluginRoot.resolve("server/" + if (com.intellij.openapi.util.SystemInfo.isWindows) "xcss.exe" else "xcss")
        require(Files.isRegularFile(binary)) { "Bundled XCSS CLI is missing. Reinstall CrossBreeze." }
        SnapshotReceiver.stop(this)
        setEnabled(content, false); status.text = if (updating) "Updating XCSS…" else "Generating XCSS…"
        val bytes = snapshot!!.toString().toByteArray()
        ApplicationManager.getApplication().executeOnPooledThread {
            var temporary: Path? = null
            val result = runCatching {
                check(!disposed) { "Project closed" }
                temporary = Files.createTempFile("crossbreeze-snapshot-", ".json")
                Files.write(temporary!!, bytes)
                val child = ProcessBuilder(binary.toString(), "cross-figma", if (updating) "update" else "import", temporary.toString(), "--root", root.toString()).directory(root.toFile()).redirectErrorStream(true).start()
                process = child
                if (disposed) child.destroy()
                val log = child.inputStream.bufferedReader().use { it.readText() }
                check(child.waitFor() == 0) { log.ifBlank { "XCSS generation failed" } }
                log
            }
            temporary?.let { runCatching { Files.deleteIfExists(it) } }; process = null
            ApplicationManager.getApplication().invokeLater {
                if (!disposed) {
                    setEnabled(content, true)
                    result.onSuccess { diagnostics.text = it; if (root.toString() !in state.generated) state.generated.add(root.toString()); render(); status.text = if (updating) "XCSS updated successfully" else "XCSS generated successfully" }
                        .onFailure { generate.isEnabled = true; diagnostics.text = it.message; status.text = "Generation failed. See diagnostics below." }
                    LocalFileSystem.getInstance().refresh(true)
                }
            }
        }
    }
    private fun setEnabled(component: java.awt.Component, enabled: Boolean) { component.isEnabled = enabled; if (component is java.awt.Container) component.components.forEach { setEnabled(it, enabled) } }
    override fun dispose() { disposed = true; SnapshotReceiver.stop(this); process?.destroy() }
}

