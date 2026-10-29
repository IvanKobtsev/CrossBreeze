package dev.crossbreeze.jetbrains

import com.intellij.lexer.LexerBase
import com.intellij.psi.TokenType
import com.intellij.psi.tree.IElementType

object XcssTokens {
    val COMMENT = IElementType("COMMENT", XcssLanguage)
    val STRING = IElementType("STRING", XcssLanguage)
    val NUMBER = IElementType("NUMBER", XcssLanguage)
    val KEYWORD = IElementType("KEYWORD", XcssLanguage)
    val IDENTIFIER = IElementType("IDENTIFIER", XcssLanguage)
    val VARIABLE = IElementType("VARIABLE", XcssLanguage)
    val PARAMETER = IElementType("PARAMETER", XcssLanguage)
    val PROPERTY = IElementType("PROPERTY", XcssLanguage)
    val PUNCTUATION = IElementType("PUNCTUATION", XcssLanguage)
}
/** Flat lexical fallback; XCSS Rust syntax remains the language authority. */
class XcssLexer : LexerBase() {
    private var buffer: CharSequence = ""
    private var end = 0
    private var start = 0
    private var cursor = 0
    private var state = 0
    private var tokenState = 0
    private var type: IElementType? = null
    override fun start(buffer: CharSequence, startOffset: Int, endOffset: Int, initialState: Int) {
        this.buffer = buffer; end = endOffset; cursor = startOffset; state = initialState
        advance()
    }
    override fun getState() = tokenState
    override fun getTokenType() = type
    override fun getTokenStart() = start
    override fun getTokenEnd() = cursor
    override fun getBufferSequence() = buffer
    override fun getBufferEnd() = end
    private fun peek(offset: Int = 0) = if (cursor + offset < end) buffer[cursor + offset] else '\u0000'
    private fun name(c: Char) = c.isLetterOrDigit() || c == '-' || c == '_' || c.code >= 128
    private fun escape() {
        cursor++
        var digits = 0
        while (cursor < end && digits < 6 && peek().digitToIntOrNull(16) != null) { cursor++; digits++ }
        if (digits > 0) { if (cursor < end && peek().isWhitespace()) cursor++ }
        else if (cursor < end) cursor++
    }
    override fun advance() {
        start = cursor; tokenState = state
        if (cursor >= end) { type = null; return }
        if (state == 1 || peek() == '/' && peek(1) == '*') {
            if (state != 1) cursor += 2
            state = 1
            while (cursor < end) {
                if (peek() == '*' && peek(1) == '/') { cursor += 2; state = 0; break }
                cursor++
            }
            type = XcssTokens.COMMENT; return
        }
        if (state == 2 || state == 3 || peek() == '\'' || peek() == '"') {
            val quote = if (state == 2) '\'' else if (state == 3) '"' else peek()
            if (state == 0) cursor++
            state = if (quote == '\'') 2 else 3
            while (cursor < end) {
                val c = peek(); cursor++
                if (c == '\\' && cursor < end) cursor++
                else if (c == quote) { state = 0; break }
                else if (c == '\n' || c == '\r') { state = 0; break }
            }
            type = XcssTokens.STRING; return
        }
        val first = peek()
        if (first.isWhitespace()) { while (cursor < end && peek().isWhitespace()) cursor++; type = TokenType.WHITE_SPACE; return }
        if (first.isDigit() || first == '.' && peek(1).isDigit()) {
            cursor++
            while (cursor < end && (name(peek()) || peek() == '.' || peek() == '%')) cursor++
            type = XcssTokens.NUMBER; return
        }
        if (first == '@' || first == '$' || name(first) || first == '\\') {
            if (first == '\\') escape() else cursor++
            while (cursor < end) { if (peek() == '\\') escape() else if (name(peek())) cursor++ else break }
            var next = cursor
            while (next < end && buffer[next].isWhitespace()) next++
            type = when {
                first == '@' -> XcssTokens.KEYWORD
                first == '$' -> XcssTokens.PARAMETER
                buffer.subSequence(start, cursor).startsWith("--") -> XcssTokens.VARIABLE
                next < end && buffer[next] == ':' -> XcssTokens.PROPERTY
                else -> XcssTokens.IDENTIFIER
            }
            return
        }
        cursor++; type = XcssTokens.PUNCTUATION
    }
}
