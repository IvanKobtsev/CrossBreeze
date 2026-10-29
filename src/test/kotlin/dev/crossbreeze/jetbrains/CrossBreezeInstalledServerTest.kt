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
    fun testBundledServerStartsAndReturnsSemanticTokens() {
        val node = System.getenv("CROSSBREEZE_TEST_NODE") ?: "node"
        NodeJsInterpreterManager.getInstance(project).setInterpreterRef(
            NodeJsInterpreterRef.create(NodeJsLocalInterpreter(node)), testRootDisposable,
        )
        val descriptor = CrossBreezeDescriptor(project)
        val process = descriptor.createCommandLine().createProcess()
        val input = process.inputStream
        fun send(value: String) {
            val bytes = value.toByteArray(Charsets.UTF_8)
            process.outputStream.write("Content-Length: ${bytes.size}\r\n\r\n".toByteArray(Charsets.US_ASCII))
            process.outputStream.write(bytes)
            process.outputStream.flush()
        }
        fun response(id: Int): JsonObject = CompletableFuture.supplyAsync {
            while (true) {
                val header = ByteArrayOutputStream()
                while (!header.toString(Charsets.US_ASCII).endsWith("\r\n\r\n")) {
                    val byte = input.read()
                    check(byte >= 0) { "Bundled server exited: ${process.errorStream.readAllBytes().toString(Charsets.UTF_8)}" }
                    header.write(byte)
                }
                val size = Regex("Content-Length: (\\d+)", RegexOption.IGNORE_CASE).find(header.toString(Charsets.US_ASCII))!!.groupValues[1].toInt()
                val message = JsonParser.parseString(input.readNBytes(size).toString(Charsets.UTF_8)).asJsonObject
                if (message.get("id")?.asInt == id) return@supplyAsync message
            }
            @Suppress("UNREACHABLE_CODE") error("No response")
        }.get(20, TimeUnit.SECONDS)
        try {
            send("""{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"processId":null,"capabilities":{},"workspaceFolders":[]}}""")
            val initialized = response(1)
            assertTrue(initialized.getAsJsonObject("result").getAsJsonObject("capabilities").getAsJsonObject("semanticTokensProvider").get("full").asBoolean)
            send("""{"jsonrpc":"2.0","method":"initialized","params":{}}""")
            send("""{"jsonrpc":"2.0","method":"textDocument/didOpen","params":{"textDocument":{"uri":"untitled:smoke.xcss","languageId":"xcss","version":1,"text":"@vars { --size: length = 1px; } .button { width: --size; }"}}}""")
            send("""{"jsonrpc":"2.0","id":2,"method":"textDocument/semanticTokens/full","params":{"textDocument":{"uri":"untitled:smoke.xcss"}}}""")
            assertTrue(response(2).getAsJsonObject("result").getAsJsonArray("data").size() > 0)
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
