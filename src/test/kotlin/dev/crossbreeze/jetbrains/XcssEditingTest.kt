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

    fun testBackspaceJoinsIndentedLine() {
        for (indent in listOf("\t\t\t", "      ", " \t  \t")) {
            myFixture.configureByText("test.xcss", ".a {\n$indent<caret>\n}")
            myFixture.performEditorAction(IdeActions.ACTION_EDITOR_BACKSPACE)
            myFixture.checkResult(".a {<caret>\n}")
        }
    }

    fun testBackspacePreservesTextAfterCaret() {
        myFixture.configureByText("test.xcss", ".a {\n\t\t<caret>color: red;\n}")
        myFixture.performEditorAction(IdeActions.ACTION_EDITOR_BACKSPACE)
        myFixture.checkResult(".a {<caret>color: red;\n}")
    }

    fun testBackspaceClearsFirstLineIndentation() {
        myFixture.configureByText("test.xcss", " \t  <caret>.a {}")
        myFixture.performEditorAction(IdeActions.ACTION_EDITOR_BACKSPACE)
        myFixture.checkResult("<caret>.a {}")
    }

    fun testBackspaceAtDocumentStart() {
        myFixture.configureByText("test.xcss", "<caret>.a {}")
        myFixture.performEditorAction(IdeActions.ACTION_EDITOR_BACKSPACE)
        myFixture.checkResult("<caret>.a {}")
    }

    fun testBackspaceDeletesOrdinaryCharacter() {
        myFixture.configureByText("test.xcss", "\tcolor<caret>: red;")
        myFixture.performEditorAction(IdeActions.ACTION_EDITOR_BACKSPACE)
        myFixture.checkResult("\tcolo<caret>: red;")
    }

    fun testBackspaceDeletesSelection() {
        myFixture.configureByText("test.xcss", ".a {\n\t<selection>\t</selection><caret>color: red;\n}")
        myFixture.performEditorAction(IdeActions.ACTION_EDITOR_BACKSPACE)
        myFixture.checkResult(".a {\n\t<caret>color: red;\n}")
    }

    fun testBackspaceDeletesPairedDelimiters() {
        for ((open, close) in listOf('{' to '}', '(' to ')', '[' to ']')) {
            myFixture.configureByText("test.xcss", "$open<caret>$close")
            myFixture.performEditorAction(IdeActions.ACTION_EDITOR_BACKSPACE)
            myFixture.checkResult("<caret>")
        }
    }

    fun testBackspaceWithMultipleCarets() {
        myFixture.configureByText("test.xcss", ".a {\n\t\t<caret>\n}\n.b {\n  \t<caret>color: red;\n}")
        myFixture.performEditorAction(IdeActions.ACTION_EDITOR_BACKSPACE)
        myFixture.checkResult(".a {<caret>\n}\n.b {<caret>color: red;\n}")
    }

    fun testBackspaceJoinCanBeUndone() {
        val before = ".a {\n\t\t<caret>\n}"
        myFixture.configureByText("test.xcss", before)
        myFixture.performEditorAction(IdeActions.ACTION_EDITOR_BACKSPACE)
        myFixture.checkResult(".a {<caret>\n}")
        myFixture.performEditorAction(IdeActions.ACTION_UNDO)
        myFixture.checkResult(before)
    }

    fun testBackspaceLeavesOtherLanguagesAlone() {
        myFixture.configureByText("test.txt", "text\n\t\t<caret>")
        myFixture.performEditorAction(IdeActions.ACTION_EDITOR_BACKSPACE)
        myFixture.checkResult("text\n\t<caret>")
    }
}
