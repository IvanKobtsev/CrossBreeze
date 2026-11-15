package dev.crossbreeze.jetbrains

import kotlin.test.*
import org.junit.Test

class CrossFigmaSnapshotTest {
    private val valid = """{"format":"crossfigma.snapshot","version":1,"collections":[],"variables":[],"styles":{"text":[],"paint":[],"effect":[],"grid":[]}}"""
    @Test fun acceptsNativeSnapshotWithoutGeneration() {
        assertEquals("crossfigma.snapshot", parseSnapshot(valid.toByteArray())["format"].asString)
    }
    @Test fun rejectsUnsupportedVersionAndMissingCollections() {
        assertFails { parseSnapshot(valid.replace("\"version\":1", "\"version\":2").toByteArray()) }
        assertFails { parseSnapshot(valid.replace("\"collections\":[],", "").toByteArray()) }
        assertFails { parseSnapshot("not JSON".toByteArray()) }
    }
    @Test fun rejectsOversizedSnapshot() { assertFails { parseSnapshot(ByteArray(SNAPSHOT_LIMIT + 1)) } }
}

