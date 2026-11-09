package dev.crossbreeze.jetbrains

import com.intellij.ide.util.PropertiesComponent
import com.intellij.openapi.vfs.VfsUtil
import com.intellij.ui.EditorNotificationProvider
import com.intellij.testFramework.fixtures.BasePlatformTestCase
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull

class XcssTypescriptSetupTest : BasePlatformTestCase() {
    private fun setup(config: String = """{"include":["src"]}""") = myFixture.addFileToProject("tsconfig.json", config).also {
        myFixture.addFileToProject("node_modules/@cross-css/vite/client.d.ts", "declare module '*.xcss' {}")
        myFixture.addFileToProject("src/Button.tsx", "import styles from './Button.xcss';")
    }

    fun testOffersFileInSourceDirectoryAndCreatesItOnce() {
        setup()
        val file = myFixture.addFileToProject("src/Button.xcss", ".button {}").virtualFile
        val plan = requireNotNull(XcssTypescriptSetup.plan(project, file))
        assertEquals("src", plan.directory.name)
        assertNull(plan.directory.findChild("xcss-env.d.ts"))
        val created = requireNotNull(XcssTypescriptSetup.create(project, plan))
        assertEquals(XcssTypescriptSetup.CONTENT, VfsUtil.loadText(created))
        assertNull(XcssTypescriptSetup.create(project, plan))
        assertNull(XcssTypescriptSetup.plan(project, file))
    }

    fun testRecognizesExistingDeclarationUnderAnyName() {
        setup()
        myFixture.addFileToProject("src/custom.d.ts", "declare module '*.xcss' { const styles: Record<string,string>; export default styles; }")
        val file = myFixture.addFileToProject("src/Button.xcss", "").virtualFile
        assertNull(XcssTypescriptSetup.plan(project, file))
    }

    fun testRecognizesClientReferenceAndTypesOption() {
        setup("""{"include":["src"],"compilerOptions":{"types":["@cross-css/vite/client"]}}""")
        val file = myFixture.addFileToProject("src/Button.xcss", "").virtualFile
        assertNull(XcssTypescriptSetup.plan(project, file))
    }

    fun testDismissalIsScopedToTheTypescriptProject() {
        setup()
        val file = myFixture.addFileToProject("src/Button.xcss", "").virtualFile
        val plan = requireNotNull(XcssTypescriptSetup.plan(project, file))
        try {
            XcssTypescriptSetup.dismiss(project, plan)
            assertNull(XcssTypescriptSetup.plan(project, file))
        } finally { PropertiesComponent.getInstance(project).unsetValue(plan.dismissalKey) }
    }

    fun testNeverOverwritesExistingFilesIncludingRaces() {
        setup()
        myFixture.addFileToProject("src/xcss-env.d.ts", "// user content")
        val file = myFixture.addFileToProject("src/Button.xcss", "").virtualFile
        val plan = requireNotNull(XcssTypescriptSetup.plan(project, file))
        assertEquals("crossbreeze-xcss-env.d.ts", plan.name)
        val existing = myFixture.addFileToProject("src/${plan.name}", "// created in another editor").virtualFile
        assertNull(XcssTypescriptSetup.create(project, plan))
        assertEquals("// created in another editor", VfsUtil.loadText(existing))
    }

    fun testTypescriptImportsOfferSetupButUnrelatedFilesDoNot() {
        setup()
        val importer = myFixture.findFileInTempDir("src/Button.tsx")
        assertNotNull(XcssTypescriptSetup.plan(project, importer))
        val other = myFixture.addFileToProject("src/other.ts", "export const x = 1").virtualFile
        assertNull(XcssTypescriptSetup.plan(project, other))
    }

    fun testDoesNotReferenceAMissingClientPackage() {
        myFixture.addFileToProject("tsconfig.json", """{"include":["src"]}""")
        val file = myFixture.addFileToProject("src/Button.xcss", "").virtualFile
        assertNull(XcssTypescriptSetup.plan(project, file))
    }

    fun testClientReferencesAndImportFormsAreRecognized() {
        assertTrue(XcssTypescriptSetup.declaresXcss("/// <reference types='@cross-css/vite/client' />"))
        assertTrue(XcssTypescriptSetup.declaresXcss("import '@cross-css/vite/client';"))
    }

    fun testExplicitFileListGetsAConfigurationHintWithoutCreatingDuplicates() {
        setup("""{"files":["src/Button.tsx"]}""")
        val file = myFixture.addFileToProject("src/Button.xcss", "").virtualFile
        val initial = requireNotNull(XcssTypescriptSetup.plan(project, file))
        val created = requireNotNull(XcssTypescriptSetup.create(project, initial))
        val followup = requireNotNull(XcssTypescriptSetup.plan(project, file))
        assertEquals(created, followup.existing)
        assertNull(XcssTypescriptSetup.create(project, followup))
    }

    fun testInheritedTypeConfigurationSuppressesTheHint() {
        setup("""{"extends":"./base.json","include":["src"]}""")
        myFixture.addFileToProject("base.json", """{"compilerOptions":{"types":["@cross-css/vite/client"]}}""")
        val file = myFixture.addFileToProject("src/Button.xcss", "").virtualFile
        assertNull(XcssTypescriptSetup.plan(project, file))
    }

    fun testNotificationProviderIsRegistered() {
        assertTrue(EditorNotificationProvider.EP_NAME.getExtensions(project).any { it is XcssTypescriptSetupNotification })
    }

    fun testSiblingProjectDeclarationDoesNotHideTheHint() {
        setup()
        myFixture.addFileToProject("other/tsconfig.json", """{"include":["src"]}""")
        myFixture.addFileToProject("other/src/env.d.ts", XcssTypescriptSetup.CONTENT)
        val file = myFixture.addFileToProject("src/Button.xcss", "").virtualFile
        assertNotNull(XcssTypescriptSetup.plan(project, file))
    }

    fun testLegacyClientStillWorks() {
        myFixture.addFileToProject("tsconfig.json", """{"include":["src"]}""")
        myFixture.addFileToProject("node_modules/@cross-css/vite-plugin/client.d.ts", "declare module '*.xcss' {}")
        val file = myFixture.addFileToProject("src/Button.xcss", "").virtualFile
        val plan = requireNotNull(XcssTypescriptSetup.plan(project, file))
        val created = requireNotNull(XcssTypescriptSetup.create(project, plan))
        assertEquals("/// <reference types=\"@cross-css/vite-plugin/client\" />\n", VfsUtil.loadText(created))
        assertNull(XcssTypescriptSetup.plan(project, file))
    }
}
