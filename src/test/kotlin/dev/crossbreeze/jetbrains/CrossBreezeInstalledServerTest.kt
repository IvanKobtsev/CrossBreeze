package dev.crossbreeze.jetbrains

import com.google.gson.JsonObject
import com.google.gson.JsonParser
import com.intellij.javascript.nodejs.interpreter.NodeJsInterpreterManager
import com.intellij.javascript.nodejs.interpreter.NodeJsInterpreterRef
import com.intellij.javascript.nodejs.interpreter.local.NodeJsLocalInterpreter
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import java.io.ByteArrayOutputStream
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** Exercises the plugin-installed server and configured interpreter, not source-tree paths. */
class CrossBreezeInstalledServerTest : BasePlatformTestCase() {
    fun testCssValidationSettingsArePassedToServer() {
        val settings = project.getService(CrossBreezeSettings::class.java)
        assertTrue(settings.state.checkCssProperties)
        assertTrue(settings.state.checkCssValues)
        settings.loadState(CrossBreezeSettings.Data(checkCssProperties = false, checkCssValues = true))
        val descriptor = CrossBreezeDescriptor(project, java.nio.file.Path.of("."))
        val options = descriptor.createInitializationOptions() as Map<*, *>
        assertEquals(false, options["checkCssProperties"])
        assertEquals(true, options["checkCssValues"])
        settings.loadState(CrossBreezeSettings.Data(checkCssProperties = true, checkCssValues = false))
        val updated = descriptor.createInitializationOptions() as Map<*, *>
        assertEquals(true, updated["checkCssProperties"])
        assertEquals(false, updated["checkCssValues"])
    }
    fun testBundledServerReturnsSemanticTokensAndCssDiagnostics() {
        val node = System.getenv("CROSSBREEZE_TEST_NODE") ?: "node"
        NodeJsInterpreterManager.getInstance(project).setInterpreterRef(
            NodeJsInterpreterRef.create(NodeJsLocalInterpreter(node)), testRootDisposable,
        )
        val provider = com.intellij.openapi.extensions.ExtensionPointName.create<com.intellij.platform.lsp.api.LspIntegrationProvider>("com.intellij.platform.lsp.integrationProvider")
            .extensionList.filterIsInstance<CrossBreezeLspIntegrationProvider>().single()
        val descriptor = provider.descriptorFor(project)
        val process = descriptor.createCommandLine().createProcess()
        val input = process.inputStream
        val notifications = mutableListOf<JsonObject>()
        fun send(value: String) {
            val bytes = value.toByteArray(Charsets.UTF_8)
            process.outputStream.write("Content-Length: ${bytes.size}\r\n\r\n".toByteArray(Charsets.US_ASCII))
            process.outputStream.write(bytes)
            process.outputStream.flush()
        }
        fun receive(): JsonObject {
            val header = ByteArrayOutputStream()
            while (!header.toString(Charsets.US_ASCII).endsWith("\r\n\r\n")) {
                val byte = input.read()
                check(byte >= 0) { "Bundled server exited: ${process.errorStream.readAllBytes().toString(Charsets.UTF_8)}" }
                header.write(byte)
            }
            val size = Regex("Content-Length: (\\d+)", RegexOption.IGNORE_CASE).find(header.toString(Charsets.US_ASCII))!!.groupValues[1].toInt()
            return JsonParser.parseString(input.readNBytes(size).toString(Charsets.UTF_8)).asJsonObject
        }
        fun response(id: Int): JsonObject = CompletableFuture.supplyAsync {
            while (true) {
                val message = receive()
                if (message.get("id")?.asInt == id) return@supplyAsync message
                notifications.add(message)
            }
            @Suppress("UNREACHABLE_CODE") error("No response")
        }.get(20, TimeUnit.SECONDS)
        try {
            send("""{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":null,"capabilities":{},"workspaceFolders":[]}}""")
            val initialized = response(1)
            assertTrue(initialized.getAsJsonObject("result").getAsJsonObject("capabilities").getAsJsonObject("semanticTokensProvider").get("full").asBoolean)
            send("""{"jsonrpc":"2.0","method":"initialized","params":{}}""")
            send("""{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"untitled:smoke.xcss","languageId":"xcss","version":1,"text":"@vars { --size: length = 1px; --duration: time = 1s; } .button { width: --size; dispay: flex; display: fex; height: --duration; } svg|a#root[data-kind='hello']:where(.item)::after > * { & + .child {} }"}}}""")
            send("""{"jsonrpc":"2.0","id":2,"method":"textDocument/semanticTokens/full","params":{"textDocument":{"uri":"untitled:smoke.xcss"}}}""")
            val semanticData = response(2).getAsJsonObject("result").getAsJsonArray("data")
            assertTrue(semanticData.size() > 0)
            val legend = initialized.getAsJsonObject("result").getAsJsonObject("capabilities")
                .getAsJsonObject("semanticTokensProvider").getAsJsonObject("legend").getAsJsonArray("tokenTypes")
                .map { it.asString }
            val highlightedTypes = (0 until semanticData.size() step 5).map { legend[semanticData[it + 3].asInt] }.toSet()
            for (type in listOf("class", "selectorId", "selectorTag", "selectorAttribute", "pseudoClass", "pseudoElement",
                "selectorUniversal", "selectorNesting", "selectorCombinator", "selectorNamespace")) {
                assertTrue(type in highlightedTypes, "Missing installed selector highlighting: $type")
            }
            val published = CompletableFuture.supplyAsync {
                notifications.firstOrNull { it.get("method")?.asString == "textDocument/publishDiagnostics" }?.let { return@supplyAsync it }
                while (true) {
                    val message = receive()
                    if (message.get("method")?.asString == "textDocument/publishDiagnostics") return@supplyAsync message
                }
                @Suppress("UNREACHABLE_CODE") error("No diagnostics")
            }.get(20, TimeUnit.SECONDS)
            val css = published.getAsJsonObject("params").getAsJsonArray("diagnostics")
                .map { it.asJsonObject }.filter { it.get("source")?.asString == "CSS" }
            assertEquals(setOf("css.unknown-property", "css.invalid-value", "css.type-mismatch"), css.map { it.get("code").asString }.toSet())
            assertTrue(css.all { it.get("severity").asInt == 2 })
            assertEquals(XcssColors.FUNCTION, descriptor.lspCustomization.semanticTokensCustomizer.let {
                (it as com.intellij.platform.lsp.api.customization.LspSemanticTokensSupport).getTextAttributesKey("function", emptyList())
            })
            send("""{"jsonrpc":"2.0","id":3,"method":"shutdown","params":null}""")
            response(3)
            send("""{"jsonrpc":"2.0","method":"exit"}""")
        } finally {
            process.destroy()
            if (!process.waitFor(5, TimeUnit.SECONDS)) process.destroyForcibly()
        }
    }
}
