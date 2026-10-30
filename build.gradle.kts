import org.jetbrains.intellij.platform.gradle.TestFrameworkType
import org.jetbrains.intellij.platform.gradle.tasks.PrepareSandboxTask
import org.jetbrains.kotlin.gradle.dsl.JvmTarget
import java.util.zip.ZipFile

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
intellijPlatform {
    pluginConfiguration {
        ideaVersion { sinceBuild = "262.9437.145" }
    }
    pluginVerification { ides { create(org.jetbrains.intellij.platform.gradle.IntelliJPlatformType.WebStorm, "2026.2.1") } }
}
val bundleServer = tasks.register<Exec>("bundleServer") {
    workingDir(rootDir)
    commandLine(if (System.getProperty("os.name").startsWith("Windows")) "npm.cmd" else "npm", "run", "bundle")
    inputs.files(fileTree("server/src"), fileTree("scripts"), file("package.json"), file("package-lock.json"))
    outputs.dir(layout.projectDirectory.dir("dist/server"))
}
tasks.withType<PrepareSandboxTask>().configureEach {
    dependsOn(bundleServer)
    from(layout.projectDirectory.dir("dist/server")) { into(pluginName.map { "$it/server" }) }
}
abstract class VerifyPluginArchive : DefaultTask() {
    @get:InputFile abstract val archive: RegularFileProperty
    @TaskAction fun verify() {
        val entries = ZipFile(archive.get().asFile).use { zip -> zip.entries().asSequence().map { it.name }.toSet() }
        check(entries.any { it.endsWith("/server/index.cjs") }) { "Missing language server" }
        check(entries.any { it.endsWith("/server/worker.cjs") }) { "Missing analysis worker" }
        for (target in listOf("darwin-arm64", "darwin-x64", "win32-arm64-msvc", "win32-x64-msvc", "linux-arm64-gnu", "linux-x64-gnu", "linux-arm64-musl", "linux-x64-musl")) {
            check(entries.any { it.endsWith("/server/node_modules/@cross-css/native-$target/xcss.node") }) { "Missing native binary: $target" }
        }
    }
}
tasks.register<VerifyPluginArchive>("verifyPluginArchive") {
    archive.set(tasks.named<Zip>("buildPlugin").flatMap { it.archiveFile })
}
