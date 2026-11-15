package dev.crossbreeze.jetbrains

import java.nio.file.Files
import java.nio.file.Path
import java.util.Comparator
import kotlin.test.*
import org.junit.Test

class CrossFigmaCliTest {
    @Test fun importThenUpdateMigratesReferencesAndRequiresBaseline() {
        // This integration test uses the same platform bundle as the plugin test sandbox.
        val os = if (System.getProperty("os.name").startsWith("Windows")) "windows" else if (System.getProperty("os.name").startsWith("Mac")) "mac" else "linux"
        val arch = if (System.getProperty("os.arch") in listOf("aarch64", "arm64")) "arm64" else "x86_64"
        val cli = Path.of("dist/native/$os-$arch/server/" + if (os == "windows") "xcss.exe" else "xcss").toAbsolutePath()
        assertTrue(Files.isRegularFile(cli), "Missing bundled CLI: $cli")
        val root = Files.createTempDirectory("crossbreeze-cli-test")
        try {
            Files.writeString(root.resolve("xcss.config.json"), """{"cross-figma":{"output":"generated","units":{"prefix":{"Spacing/":"px"}}}}""")
            fun snapshot(name: String, value: Int) = """{"format":"crossfigma.snapshot","version":1,"collections":[{"id":"c","name":"Tokens","defaultModeId":"base","modes":[{"modeId":"base","name":"Base"}]}],"variables":[{"id":"v","name":"Spacing/$name","variableCollectionId":"c","resolvedType":"FLOAT","valuesByMode":{"base":$value}}],"styles":{"text":[],"paint":[],"effect":[],"grid":[]}}"""
            fun run(command: String): Pair<Int, String> {
                val child = ProcessBuilder(cli.toString(), "cross-figma", command, "snapshot.json", "--root", root.toString()).directory(root.toFile()).redirectErrorStream(true).start()
                val log = child.inputStream.bufferedReader().readText()
                return child.waitFor() to log
            }
            Files.writeString(root.resolve("snapshot.json"), snapshot("Base", 16))
            assertFalse(Files.exists(root.resolve("generated")), "Intake must not generate files")
            val first = run("import"); assertEquals(0, first.first, first.second)
            assertTrue(Files.exists(root.resolve("generated/.cross-figma.json")))
            Files.writeString(root.resolve("consumer.xcss"), ".box { width: --spacing-base; }")
            Files.writeString(root.resolve("snapshot.json"), snapshot("Large", 24))
            val updated = run("update"); assertEquals(0, updated.first, updated.second)
            assertTrue(Files.readString(root.resolve("consumer.xcss")).contains("--spacing-large"))
            assertTrue(Files.readString(root.resolve("generated/globals.gen.xcss")).contains("24px"))
            val migrated = Files.readString(root.resolve("consumer.xcss"))
            val repeated = run("update"); assertEquals(0, repeated.first, repeated.second)
            assertEquals(migrated, Files.readString(root.resolve("consumer.xcss")))
            val deleted = com.google.gson.JsonParser.parseString(snapshot("Large", 24)).asJsonObject
            deleted.add("variables", com.google.gson.JsonArray())
            Files.writeString(root.resolve("snapshot.json"), deleted.toString())
            val removed = run("update"); assertEquals(0, removed.first, removed.second)
            assertTrue(removed.second.contains("deleted variable"))
            assertEquals(migrated, Files.readString(root.resolve("consumer.xcss")))
            Files.delete(root.resolve("generated/.cross-figma.json"))
            val before = Files.readString(root.resolve("consumer.xcss"))
            assertNotEquals(0, run("update").first)
            assertEquals(before, Files.readString(root.resolve("consumer.xcss")))
        } finally {
            Files.walk(root).use { it.sorted(Comparator.reverseOrder()).forEach(Files::delete) }
        }
    }
}


