package dev.crossbreeze.jetbrains

import java.net.HttpURLConnection
import java.net.URI
import kotlin.test.*
import org.junit.Test

class CrossFigmaReceiverTest {
    @Test fun healthPreflightValidationAndExclusiveOwnership() {
        val owner = Any()
        var accepted: ByteArray? = null
        SnapshotReceiver.start(owner) { accepted = it }
        try {
            fun request(method: String, path: String, body: String? = null): Pair<Int, String> {
                val connection = URI("http://127.0.0.1:38473$path").toURL().openConnection() as HttpURLConnection
                connection.requestMethod = method; connection.connectTimeout = 3000; connection.readTimeout = 3000
                if (body != null) { connection.doOutput = true; connection.setRequestProperty("Content-Type", "application/json"); connection.outputStream.use { it.write(body.toByteArray()) } }
                val code = connection.responseCode
                assertEquals("*", connection.getHeaderField("Access-Control-Allow-Origin"))
                val text = (if (code >= 400) connection.errorStream else connection.inputStream)?.bufferedReader()?.use { it.readText() }.orEmpty()
                connection.disconnect(); return code to text
            }
            assertEquals(200, request("GET", "/health").first)
            assertEquals(204, request("OPTIONS", "/design-tokens").first)
            assertEquals(400, request("POST", "/design-tokens", "{}").first)
            assertNull(accepted)
            assertFails { SnapshotReceiver.start(Any()) {} }
            SnapshotReceiver.stop(Any())
            assertEquals(200, request("GET", "/health").first)
            assertEquals(200, request("POST", "/design-tokens", """{"format":"crossfigma.snapshot","version":1,"collections":[],"variables":[],"styles":{"text":[],"paint":[],"effect":[],"grid":[]}}""").first)
            assertNotNull(accepted)
        } finally { SnapshotReceiver.stop(owner) }
    }
}
