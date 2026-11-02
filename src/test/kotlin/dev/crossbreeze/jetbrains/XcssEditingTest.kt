package dev.crossbreeze.jetbrains

import com.intellij.testFramework.fixtures.BasePlatformTestCase
import com.intellij.openapi.actionSystem.IdeActions

class XcssEditingTest : BasePlatformTestCase() {
    override fun setUp() {
        super.setUp()
        project.getService(CrossBreezeSettings::class.java).state.enabled = false
    }
    fun testCommentToggle() {
        myFixture.configureByText("test.xcss", "<selection>.a { color: red; }</selection>")
        myFixture.performEditorAction(IdeActions.ACTION_COMMENT_LINE)
        assertTrue(myFixture.editor.document.text.contains("/*"))
        myFixture.performEditorAction(IdeActions.ACTION_COMMENT_LINE)
        myFixture.checkResult(".a { color: red; }")
    }

    fun testBracketPairing() {
        for ((open, close) in listOf('{' to '}', '(' to ')', '[' to ']')) {
            myFixture.configureByText("test.xcss", "<caret>")
            myFixture.type(open)
            myFixture.checkResult("$open<caret>$close")
        }
    }

    fun testEnterBetweenBraces() {
        myFixture.configureByText("test.xcss", ".a {<caret>}")
        val options = com.intellij.application.options.CodeStyle.getIndentOptions(myFixture.file)
        val unit = if (options.USE_TAB_CHARACTER) "\t" else " ".repeat(options.INDENT_SIZE)
        myFixture.performEditorAction(IdeActions.ACTION_EDITOR_ENTER)
        myFixture.checkResult(".a {\n$unit<caret>\n}")
    }

    fun testEnterPreservesIndentation() {
        myFixture.configureByText("test.xcss", ".a {\n\tcolor: red;<caret>\n}")
        myFixture.performEditorAction(IdeActions.ACTION_EDITOR_ENTER)
        myFixture.checkResult(".a {\n\tcolor: red;\n\t<caret>\n}")
    }

    fun testDelimitersInsideStringDoNotIndent() {
        myFixture.configureByText("test.xcss", "  content: \"{\";<caret>")
        myFixture.performEditorAction(IdeActions.ACTION_EDITOR_ENTER)
        myFixture.checkResult("  content: \"{\";\n  <caret>")
    }
}
