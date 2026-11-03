package dev.crossbreeze.jetbrains

import com.intellij.lang.BracePair
import com.intellij.lang.Commenter
import com.intellij.lang.PairedBraceMatcher
import com.intellij.codeInsight.editorActions.SimpleTokenSetQuoteHandler
import com.intellij.codeInsight.editorActions.enter.EnterHandlerDelegate
import com.intellij.openapi.actionSystem.DataContext
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.editor.actionSystem.EditorActionHandler
import com.intellij.openapi.util.Ref
import com.intellij.psi.PsiFile
import com.intellij.application.options.CodeStyle
import com.intellij.psi.tree.IElementType

/** XCSS supports CSS block comments, including for the IDE's line-comment action. */
class XcssCommenter : Commenter, com.intellij.codeInsight.generation.CommenterWithLineSuffix {
    override fun getLineCommentPrefix() = "/*"
    override fun getLineCommentSuffix() = "*/"
    override fun getBlockCommentPrefix() = "/*"
    override fun getBlockCommentSuffix() = "*/"
    override fun getCommentedBlockCommentPrefix(): String? = null
    override fun getCommentedBlockCommentSuffix(): String? = null
}

class XcssBraceMatcher : PairedBraceMatcher {
    override fun getPairs() = arrayOf(
        BracePair(XcssTokens.LBRACE, XcssTokens.RBRACE, true),
        BracePair(XcssTokens.LPAREN, XcssTokens.RPAREN, false),
        BracePair(XcssTokens.LBRACKET, XcssTokens.RBRACKET, false),
    )
    override fun isPairedBracesAllowedBeforeType(lbraceType: IElementType, contextType: IElementType?) = true
    override fun getCodeConstructStart(file: PsiFile, openingBraceOffset: Int) = openingBraceOffset
}

class XcssQuoteHandler : SimpleTokenSetQuoteHandler(XcssTokens.STRING)

/** Preserve existing indentation; add one configured level after an opening delimiter. */
class XcssEnterHandler : EnterHandlerDelegate {
    override fun preprocessEnter(
        file: PsiFile, editor: Editor, caretOffset: Ref<Int>, caretAdvance: Ref<Int>,
        dataContext: DataContext, originalHandler: EditorActionHandler?,
    ): EnterHandlerDelegate.Result {
        if (file.language != XcssLanguage) return EnterHandlerDelegate.Result.Continue
        val offset = caretOffset.get()
        val document = editor.document
        val text = document.charsSequence
        val lineStart = document.getLineStartOffset(document.getLineNumber(offset))
        val lexer = XcssLexer()
        lexer.start(text)
        var previous: IElementType? = null
        while (lexer.tokenType != null && lexer.tokenStart < offset) {
            // Leave strings and comments to the IDE's normal Enter handling.
            if (lexer.tokenEnd > offset && (lexer.tokenType == XcssTokens.STRING || lexer.tokenType == XcssTokens.COMMENT))
                return EnterHandlerDelegate.Result.Continue
            if (lexer.tokenEnd > lineStart && lexer.tokenType != com.intellij.psi.TokenType.WHITE_SPACE) previous = lexer.tokenType
            lexer.advance()
        }
        val base = text.subSequence(lineStart, offset).takeWhile { it == ' ' || it == '\t' }.toString()
        val opening = previous in setOf(XcssTokens.LBRACE, XcssTokens.LPAREN, XcssTokens.LBRACKET)
        val options = CodeStyle.getIndentOptions(file)
        val unit = if (options.USE_TAB_CHARACTER) "\t" else " ".repeat(options.INDENT_SIZE)
        val indent = base + if (opening) unit else ""
        val close = when (previous) {
            XcssTokens.LBRACE -> '}'
            XcssTokens.LPAREN -> ')'
            XcssTokens.LBRACKET -> ']'
            else -> null
        }
        val paired = opening && offset < text.length && text[offset] == close
        document.insertString(offset, "\n" + indent + if (paired) "\n$base" else "")
        editor.caretModel.moveToOffset(offset + 1 + indent.length)
        return EnterHandlerDelegate.Result.Stop
    }
}
