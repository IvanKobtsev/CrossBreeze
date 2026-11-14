package dev.crossbreeze.jetbrains

import com.intellij.openapi.util.SystemInfo
import java.nio.file.Path

internal fun nativeServer(pluginRoot: Path): Path =
    pluginRoot.resolve("server/" + if (SystemInfo.isWindows) "crossbreeze.exe" else "crossbreeze")
