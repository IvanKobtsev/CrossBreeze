import groovy.json.JsonSlurper
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
    id("org.jetbrains.intellij.platform") version "2.19.0"
}
repositories { mavenCentral(); intellijPlatform { defaultRepositories() } }
dependencies {
    intellijPlatform {
        webstorm("2026.2.1")
        bundledPlugin("JavaScript")
        bundledPlugin("NodeJS")
        testFramework(TestFrameworkType.Platform)
    }
    testImplementation(kotlin("test"))
}
kotlin { jvmToolchain(25); compilerOptions { jvmTarget = JvmTarget.JVM_25 } }

val nativeTargetsFile = layout.projectDirectory.file("scripts/native-targets.json")
@Suppress("UNCHECKED_CAST")
val nativeTargets = JsonSlurper().parse(nativeTargetsFile.asFile) as Map<String, List<String>>
val bundleDirectory = layout.projectDirectory.dir("dist/bundle")
val npm = if (System.getProperty("os.name").startsWith("Windows")) "npm.cmd" else "npm"
val nativeBundles = nativeTargets.keys.associateWith { target ->
    tasks.register<Exec>("bundleNative_${target.replace('-', '_')}") {
        workingDir(rootDir)
        commandLine("node", "scripts/bundle-native.mjs", "--target", target)
        inputs.files(fileTree("scripts"), file("package.json"), file("package-lock.json"))
        outputs.dir(bundleDirectory.dir(target))
    }
}

intellijPlatform {
    pluginConfiguration {
        ideaVersion { sinceBuild = "262.9437.145" }
    }
    pluginVerification { ides { create(org.jetbrains.intellij.platform.gradle.IntelliJPlatformType.WebStorm, "2026.2.1") } }
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
val bundleServer = tasks.register<Exec>("bundleServer") {
    workingDir(rootDir)
    commandLine(npm, "run", "bundle", "--", "--common")
    inputs.files(fileTree("server/src"), fileTree("scripts"), file("package.json"), file("package-lock.json"))
    outputs.dir(bundleDirectory.dir("common"))
}
tasks.withType<PrepareSandboxTask>().configureEach {
    dependsOn(bundleServer)
    from(bundleDirectory.dir("common")) { into(pluginName) }
}

abstract class VerifyPluginArchive : DefaultTask() {
    @get:InputFiles abstract val archives: ConfigurableFileCollection
    @get:InputFile abstract val lockfile: RegularFileProperty
    @get:Input abstract val targets: MapProperty<String, List<String>>
    @get:Input abstract val baseName: Property<String>

    @TaskAction fun verify() {
        val zips = archives.files.associateBy { it.name }
        val expected = targets.get()
        check(zips.keys == expected.keys.map { "${baseName.get()}-$it.zip" }.toSet()) {
            "Expected all six targeted plugin archives. Found ${zips.keys}"
        }
        val lock = JsonSlurper().parse(lockfile.get().asFile) as Map<*, *>
        val packages = lock["packages"] as Map<*, *>
        val loader = "@cross-css/native"
        for ((target, binaries) in expected) {
            val name = "${baseName.get()}-$target.zip"
            val archive = zips.getValue(name)
            ZipFile(archive).use { zip ->
                val entries = zip.entries().asSequence().filterNot { it.isDirectory }.map { it.name }.toList()
                check(entries.size == entries.toSet().size) { "$name contains duplicate paths" }
                val server = entries.single { it.endsWith("/server/index.cjs") }.removeSuffix("index.cjs")
                val root = server.removeSuffix("server/")
                val modules = "${server}node_modules/"
                val nativePackages = binaries.map { "$loader-$it" }.toSet()
                val expectedPackages = nativePackages + loader
                val actualPackages = entries.filter { it.startsWith("$modules$loader") }
                    .map { it.removePrefix(modules).split('/').take(2).joinToString("/") }.toSet()
                check(actualPackages == expectedPackages) { "$name contains the wrong native packages: $actualPackages" }
                check(entries.filter { it.endsWith("/xcss.node") }.toSet() == nativePackages.map { "$modules$it/xcss.node" }.toSet()) {
                    "$name contains the wrong native binaries"
                }
                for (file in listOf("index.cjs.map", "worker.cjs", "worker.cjs.map")) {
                    check(server + file in entries) { "$name is missing $file" }
                }
                val manifest = readManifest(zip, "${server}native-loader-manifest.json", setOf(loader)) +
                    readManifest(zip, "${server}native-platform-manifest.json", nativePackages)
                for (item in manifest) {
                    val pkg = item["name"] as String
                    val locked = packages["node_modules/$pkg"] as Map<*, *>
                    for (key in listOf("version", "resolved", "integrity")) {
                        check(item[key] == locked[key]) { "$name has incorrect lock metadata for $pkg ($key)" }
                    }
                    val prefix = "$modules$pkg/"
                    val hashes = item["hashes"] as Map<*, *>
                    val required = if (pkg == loader) {
                        setOf("package.json", "index.js", "platform.cjs", "LICENSE", "TSRS-LICENSE", "TSRS-NOTICE")
                    } else setOf("package.json", "xcss.node", "LICENSE")
                    check(hashes.keys.containsAll(required)) { "$name is missing required files for $pkg" }
                    check(hashes.keys == entries.filter { it.startsWith(prefix) }.map { it.removePrefix(prefix) }.toSet()) {
                        "$name has an incomplete manifest for $pkg"
                    }
                    for ((file, hash) in hashes) {
                        val digest = MessageDigest.getInstance("SHA-256")
                        zip.getInputStream(zip.getEntry(prefix + file)).use { input ->
                            val buffer = ByteArray(8192)
                            while (true) {
                                val count = input.read(buffer)
                                if (count == -1) break
                                digest.update(buffer, 0, count)
                            }
                        }
                        check(digest.digest().toHexString() == hash) { "$name failed SHA-256 verification for $pkg/$file" }
                    }
                }
                verifyDescriptor(zip, entries, root, target)
            }
            logger.lifecycle("Verified $name (${archive.length()} bytes)")
        }
    }

    private fun readManifest(zip: ZipFile, path: String, expected: Set<String>): List<Map<*, *>> {
        val entry = checkNotNull(zip.getEntry(path)) { "Missing $path in ${zip.name}" }
        val manifest = zip.getInputStream(entry).use { input ->
            (JsonSlurper().parse(input) as List<*>).map { it as Map<*, *> }
        }
        check(manifest.size == expected.size && manifest.map { it["name"] }.toSet() == expected) {
            "Unexpected packages in $path of ${zip.name}"
        }
        return manifest
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
    lockfile.set(layout.projectDirectory.file("package-lock.json"))
    targets.set(nativeTargets)
    baseName.set("${project.name}-${project.version}")
}
