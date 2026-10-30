package dev.crossbreeze.jetbrains

import com.intellij.openapi.editor.DefaultLanguageHighlighterColors as Colors
import com.intellij.openapi.editor.colors.TextAttributesKey
import com.intellij.openapi.fileTypes.SyntaxHighlighterBase
import com.intellij.openapi.fileTypes.SyntaxHighlighterFactory
import com.intellij.openapi.options.colors.AttributesDescriptor
import com.intellij.openapi.options.colors.ColorDescriptor
import com.intellij.openapi.options.colors.ColorSettingsPage
import com.intellij.openapi.project.Project
import com.intellij.openapi.vfs.VirtualFile
import com.intellij.psi.tree.IElementType

object XcssColors {
    val FUNCTION = TextAttributesKey.createTextAttributesKey("XCSS.INJECTION", Colors.FUNCTION_DECLARATION)
    val PARAMETER = TextAttributesKey.createTextAttributesKey("XCSS.PARAMETER", Colors.PARAMETER)
    val VARIABLE = TextAttributesKey.createTextAttributesKey("XCSS.VARIABLE", Colors.INSTANCE_FIELD)
    val NAMESPACE = TextAttributesKey.createTextAttributesKey("XCSS.NAMESPACE", Colors.CLASS_REFERENCE)
    val TYPE = TextAttributesKey.createTextAttributesKey("XCSS.TYPE", Colors.CLASS_NAME)
    val CLASS = TextAttributesKey.createTextAttributesKey("XCSS.CLASS", Colors.CLASS_NAME)
    val KEYFRAME = TextAttributesKey.createTextAttributesKey("XCSS.KEYFRAME", Colors.STATIC_FIELD)
    val PROPERTY = TextAttributesKey.createTextAttributesKey("XCSS.PROPERTY", Colors.INSTANCE_FIELD)
    val semantic = linkedMapOf("function" to FUNCTION, "parameter" to PARAMETER, "variable" to VARIABLE,
        "namespace" to NAMESPACE, "type" to TYPE, "class" to CLASS, "enumMember" to KEYFRAME, "property" to PROPERTY)
}
class XcssSyntaxHighlighter : SyntaxHighlighterBase() {
    override fun getHighlightingLexer() = XcssLexer()
    override fun getTokenHighlights(type: IElementType): Array<TextAttributesKey> = pack(when (type) {
        XcssTokens.COMMENT -> Colors.BLOCK_COMMENT
        XcssTokens.STRING -> Colors.STRING
        XcssTokens.NUMBER -> Colors.NUMBER
        XcssTokens.KEYWORD -> Colors.KEYWORD
        XcssTokens.VARIABLE -> XcssColors.VARIABLE
        XcssTokens.PARAMETER -> XcssColors.PARAMETER
        XcssTokens.PROPERTY -> XcssColors.PROPERTY
        XcssTokens.PUNCTUATION -> Colors.OPERATION_SIGN
        else -> null
    })
}
class XcssSyntaxHighlighterFactory : SyntaxHighlighterFactory() {
    override fun getSyntaxHighlighter(project: Project?, virtualFile: VirtualFile?) = XcssSyntaxHighlighter()
}
class XcssColorSettingsPage : ColorSettingsPage {
    override fun getDisplayName() = "XCSS"
    override fun getIcon() = XcssFileType.INSTANCE.icon
    override fun getHighlighter() = XcssSyntaxHighlighter()
    override fun getDemoText() = """
        /* XCSS lexical and semantic colors */
        @vars { local <variable>--accent</variable>: <type>color</type> = red; }
        @injection <function>paint</function>(<parameter>${'$'}tone</parameter>: <type>color</type> = red) {
          <property>color</property>: <parameter>${'$'}tone</parameter>;
        }
        @import <namespace>theme</namespace> from "./theme.xcss";
        .<class>button</class> { @:<namespace>theme</namespace>.<function>paint</function>(); }
        @keyframes <enumMember>spin</enumMember> { to { opacity: 1; } }
    """.trimIndent()
    override fun getAdditionalHighlightingTagToDescriptorMap() = XcssColors.semantic
    override fun getAttributeDescriptors() = XcssColors.semantic.map { (name, key) -> AttributesDescriptor(name, key) }.toTypedArray()
    override fun getColorDescriptors() = ColorDescriptor.EMPTY_ARRAY
}
