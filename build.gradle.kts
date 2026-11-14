import groovy.json.JsonSlurper
import java.io.File
import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.intellij.platform.gradle.tasks.BuildPluginVariantsTask
import org.jetbrains.intellij.platform.gradle.tasks.PrepareSandboxTask
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.security.MessageDigest
import java.util.zip.ZipFile
import java.util.zip.ZipInputStream
import javax.xml.parsers.DocumentBuilderFactory

plugins {
    id("org.jetbrains.kotlin.jvm") version "2.3.20"
    id("org.jetbrains.intellij.platform") version "2.20.1"
}
repositories { mavenCentral(); intellijPlatform { defaultRepositories() } }
dependencies {
    intellijPlatform {
        webstorm("2026.3")
        bundledPlugin("JavaScript")
        testFramework(TestFrameworkType.Platform)
    }
    testImplementation(kotlin("test"))
}
kotlin { jvmToolchain(25); compilerOptions { jvmTarget = JvmTarget.JVM_25 } }

val nativeTargetsFile = layout.projectDirectory.file("scripts/native-targets.json")
@Suppress("UNCHECKED_CAST")
val nativeTargets = JsonSlurper().parse(nativeTargetsFile.asFile) as Map<String, List<String>>
val bundleDirectory = layout.projectDirectory.dir("dist/native")
val cargoExecutable = providers.environmentVariable("CARGO").orElse(
    File(System.getProperty("user.home"), ".cargo/bin/" + if (System.getProperty("os.name").startsWith("Windows")) "cargo.exe" else "cargo").let { if (it.isFile) it.absolutePath else "cargo" }
)
val hostOs = System.getProperty("os.name").let { if (it.startsWith("Windows")) "windows" else if (it.startsWith("Mac")) "mac" else "linux" }
val hostArch = System.getProperty("os.arch").let { if (it in listOf("aarch64", "arm64")) "arm64" else "x86_64" }
val hostTarget = "$hostOs-$hostArch"
val nativeBundles = nativeTargets.keys.associateWith { target ->
    tasks.register<Exec>("bundleNative_${target.replace('-', '_')}") {
        workingDir(rootDir)
        val arguments = mutableListOf(cargoExecutable.get(), "run", "--locked", "-p", "crossbreeze-build", "--", "bundle", "--target", target)
        val nativeDebug = providers.gradleProperty("crossbreeze.nativeDebug").orNull == "true"
        if (nativeDebug) arguments += "--debug"
        inputs.property("nativeDebug", nativeDebug)
        commandLine(arguments)
        val buildNative = providers.gradleProperty("crossbreeze.prebuiltNative").orNull != "true"
        onlyIf { buildNative }
        inputs.files(fileTree("crates"), file("Cargo.toml"), file("Cargo.lock"), file("rust-toolchain.toml"))
        outputs.dir(bundleDirectory.dir(target))
    }
}
intellijPlatform {
    pluginConfiguration {
        ideaVersion { sinceBuild = "263.7307.202" }
    }
    pluginVerification { ides { create(org.jetbrains.intellij.platform.gradle.IntelliJPlatformType.WebStorm, "2026.3") } }
    nativeVariants {
        enabled = true
        linux.x86_64.from(nativeBundles.getValue("linux-x86_64"))
        linux.arm64.from(nativeBundles.getValue("linux-arm64"))
        mac.x86_64.from(nativeBundles.getValue("mac-x86_64"))
        mac.arm64.from(nativeBundles.getValue("mac-arm64"))
        windows.x86_64.from(nativeBundles.getValue("windows-x86_64"))
        windows.arm64.from(nativeBundles.getValue("windows-arm64"))
    }
}
tasks.named<PrepareSandboxTask>("prepareTestSandbox") {
    dependsOn(nativeBundles.getValue(hostTarget))
    from(bundleDirectory.dir(hostTarget)) { into(pluginName) }
}
abstract class VerifyPluginArchive : DefaultTask() {
    @get:InputFiles abstract val archives: ConfigurableFileCollection
    @get:Input abstract val targets: MapProperty<String, List<String>>
    @get:Input abstract val baseName: Property<String>

    @TaskAction fun verify() {
        val zips = archives.files.associateBy { it.name }
        val expected = targets.get()
        check(zips.keys == expected.keys.map { "${baseName.get()}-$it.zip" }.toSet()) { "Expected all six native plugin archives" }
        for (target in expected.keys) {
            val archive = zips.getValue("${baseName.get()}-$target.zip")
            ZipFile(archive).use { zip ->
                val entries = zip.entries().asSequence().filterNot { it.isDirectory }.map { it.name }.toList()
                check(entries.size == entries.toSet().size) { "Duplicate archive paths" }
                check(entries.none { it.contains("/node_modules/") || it.endsWith(".node") || it.endsWith(".cjs") }) { "Node artifacts in native archive" }
                val manifestPath = entries.single { it.endsWith("/server/native-manifest.json") }
                val server = manifestPath.removeSuffix("native-manifest.json")
                val manifest = zip.getInputStream(zip.getEntry(manifestPath)).use { JsonSlurper().parse(it) as Map<*, *> }
                check(manifest["target"] == target)
                check(manifest["profile"] == "release") { "Debug executable in release archive" }
                val hashes = manifest["files"] as Map<*, *>
                val executable = if (target.startsWith("windows-")) "crossbreeze.exe" else "crossbreeze"
                check(hashes.containsKey(executable) && hashes.containsKey("Cargo.lock"))
                check(entries.filter { it.startsWith(server) }.toSet() == hashes.keys.map { server + it }.toSet() + manifestPath) { "Unmanifested native files" }
                for ((path, hash) in hashes) {
                    val bytes = zip.getInputStream(checkNotNull(zip.getEntry(server + path))).use { it.readBytes() }
                    check(MessageDigest.getInstance("SHA-256").digest(bytes).toHexString() == hash) { "Integrity mismatch: $path" }
                }
                verifyDescriptor(zip, entries, server.removeSuffix("server/"), target)
            }
        }
    }
    private fun verifyDescriptor(zip: ZipFile, entries: List<String>, root: String, target: String) {
        val factory = DocumentBuilderFactory.newInstance().apply {
            setFeature("http://apache.org/xml/features/disallow-doctype-decl", true)
        }
        val descriptors = entries.filter { it.startsWith("${root}lib/") && it.endsWith(".jar") }.mapNotNull { name ->
            ZipInputStream(zip.getInputStream(zip.getEntry(name))).use { jar ->
                generateSequence { jar.nextEntry }.firstOrNull { it.name == "META-INF/plugin.xml" }
                    ?.let { factory.newDocumentBuilder().parse(jar.readBytes().inputStream()) }
            }
        }
        val descriptor = descriptors.single()
        check(descriptor.getElementsByTagName("id").item(0).textContent == "dev.crossbreeze.jetbrains")
        val version = baseName.get().removePrefix("crossbreeze-")
        check(descriptor.getElementsByTagName("version").item(0).textContent == "$version-$target")
        val dependencies = descriptor.getElementsByTagName("depends")
        val modules = (0 until dependencies.length).mapNotNull { index ->
            val dependency = dependencies.item(index)
            dependency.textContent.trim().takeUnless { dependency.attributes.getNamedItem("optional")?.nodeValue == "true" }
        }.filter { it.startsWith("com.intellij.modules.os.") || it.startsWith("com.intellij.modules.arch.") }
        val (os, arch) = target.split('-')
        check(modules.toSet() == setOf("com.intellij.modules.os.$os", "com.intellij.modules.arch.$arch") && modules.size == 2) {
            "Wrong target dependencies in ${zip.name}: $modules"
        }
    }
}
tasks.register<VerifyPluginArchive>("verifyPluginArchive") {
    archives.from(tasks.named<BuildPluginVariantsTask>("buildPluginVariants").map { it.archiveFiles })
    targets.set(nativeTargets)
    baseName.set("${project.name}-${project.version}")
}

tasks.withType<Zip>().configureEach {
    filesMatching("**/server/crossbreeze") {
        permissions { unix("rwxr-xr-x") }
    }
}
