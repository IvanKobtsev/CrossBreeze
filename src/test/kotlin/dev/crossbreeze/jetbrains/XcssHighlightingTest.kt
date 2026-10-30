package dev.crossbreeze.jetbrains

import com.intellij.testFramework.fixtures.BasePlatformTestCase
import kotlin.test.assertEquals
import kotlin.test.assertTrue

class XcssHighlightingTest : BasePlatformTestCase() {
    fun testFileTypeAndFlatRecovery() {
        val file = myFixture.configureByText("test.xcss", ".a { @:paint(\ncolor: red; } .later { width: --size; }")
        assertEquals(XcssLanguage, file.language)
        assertEquals(XcssFileType.INSTANCE, file.fileType)
        assertEquals(file.text, file.node.text)
    }
    fun testLexerRestartsAtEveryToken() {
        val text = "/* 😀\n comment */ @vars { --size: length = 1px; } .café { content: \"hi\"; }"
        val lexer = XcssLexer()
        lexer.start(text)
        var count = 0
        while (lexer.tokenType != null) {
            val restarted = XcssLexer()
            restarted.start(text, lexer.tokenStart, text.length, lexer.state)
            assertEquals(lexer.tokenType, restarted.tokenType)
            assertEquals(lexer.tokenEnd, restarted.tokenEnd)
            assertTrue(lexer.tokenEnd > lexer.tokenStart)
            count++; lexer.advance()
        }
        assertTrue(count > 10)
    }
    fun testSemanticLegendAndLexicalFallback() {
        assertEquals(listOf("function", "parameter", "variable", "namespace", "type", "class", "enumMember", "property",
            "selectorId", "selectorTag", "selectorAttribute", "pseudoClass", "pseudoElement", "selectorUniversal",
            "selectorNesting", "selectorCombinator", "selectorNamespace"), XcssColors.semantic.keys.toList())
        assertTrue(XcssSyntaxHighlighter().getTokenHighlights(XcssTokens.VARIABLE).isNotEmpty())
        assertTrue(XcssSyntaxHighlighter().getTokenHighlights(XcssTokens.PARAMETER).isNotEmpty())
        assertTrue(XcssSyntaxHighlighter().getTokenHighlights(XcssTokens.COMMENT).isNotEmpty())
    }
    fun testAliasesValidation() {
        assertEquals(listOf("src/*"), CrossBreezeSettings.parseAliases("""{"@styles/*":["src/*"]}""")["@styles/*"])
    }
    fun testSemanticTokensAreRequestedForXcssLanguage() {
        val file = myFixture.configureByText("selectors.xcss", ".button { color: red; }")
        val descriptor = CrossBreezeDescriptor(project, java.nio.file.Path.of("."))
        val support = descriptor.lspCustomization.semanticTokensCustomizer as com.intellij.platform.lsp.api.customization.LspSemanticTokensSupport
        assertTrue(support.shouldAskServerForSemanticTokens(file))
        for ((type, key) in XcssColors.semantic) {
            assertEquals(key, support.getTextAttributesKey(type, emptyList()))
        }
        assertEquals("XCSS.CLASS", XcssColors.CLASS.externalName)
        assertEquals(XcssColors.semantic.size, XcssColorSettingsPage().attributeDescriptors.map { it.key }.toSet().size)
    }
}
