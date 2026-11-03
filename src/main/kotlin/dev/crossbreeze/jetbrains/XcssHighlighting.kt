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
    val SELECTOR_ID = TextAttributesKey.createTextAttributesKey("XCSS.SELECTOR_ID", Colors.STATIC_FIELD)
    val SELECTOR_TAG = TextAttributesKey.createTextAttributesKey("XCSS.SELECTOR_TAG", Colors.KEYWORD)
    val SELECTOR_ATTRIBUTE = TextAttributesKey.createTextAttributesKey("XCSS.SELECTOR_ATTRIBUTE", Colors.INSTANCE_FIELD)
    val PSEUDO_CLASS = TextAttributesKey.createTextAttributesKey("XCSS.PSEUDO_CLASS", Colors.FUNCTION_CALL)
    val PSEUDO_ELEMENT = TextAttributesKey.createTextAttributesKey("XCSS.PSEUDO_ELEMENT", Colors.METADATA)
    val SELECTOR_UNIVERSAL = TextAttributesKey.createTextAttributesKey("XCSS.SELECTOR_UNIVERSAL", Colors.KEYWORD)
    val SELECTOR_NESTING = TextAttributesKey.createTextAttributesKey("XCSS.SELECTOR_NESTING", Colors.KEYWORD)
    val SELECTOR_COMBINATOR = TextAttributesKey.createTextAttributesKey("XCSS.SELECTOR_COMBINATOR", Colors.OPERATION_SIGN)
    val SELECTOR_NAMESPACE = TextAttributesKey.createTextAttributesKey("XCSS.SELECTOR_NAMESPACE", Colors.CLASS_REFERENCE)
    val semantic = linkedMapOf("function" to FUNCTION, "parameter" to PARAMETER, "variable" to VARIABLE,
        "namespace" to NAMESPACE, "type" to TYPE, "class" to CLASS, "enumMember" to KEYFRAME, "property" to PROPERTY,
        "selectorId" to SELECTOR_ID, "selectorTag" to SELECTOR_TAG, "selectorAttribute" to SELECTOR_ATTRIBUTE,
        "pseudoClass" to PSEUDO_CLASS, "pseudoElement" to PSEUDO_ELEMENT, "selectorUniversal" to SELECTOR_UNIVERSAL,
        "selectorNesting" to SELECTOR_NESTING, "selectorCombinator" to SELECTOR_COMBINATOR, "selectorNamespace" to SELECTOR_NAMESPACE)
    val displayNames = mapOf(
        "function" to "Injection", "parameter" to "Parameter", "variable" to "Variable", "namespace" to "Import namespace",
        "type" to "Type", "class" to "Selectors//Class", "enumMember" to "Keyframe", "property" to "Property",
        "selectorId" to "Selectors//ID", "selectorTag" to "Selectors//Tag", "selectorAttribute" to "Selectors//Attribute",
        "pseudoClass" to "Selectors//Pseudo-class", "pseudoElement" to "Selectors//Pseudo-element",
        "selectorUniversal" to "Selectors//Universal", "selectorNesting" to "Selectors//Nesting",
        "selectorCombinator" to "Selectors//Combinator", "selectorNamespace" to "Selectors//Namespace prefix")
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
        <selectorNamespace>svg|</selectorNamespace><selectorTag>a</selectorTag>.<class>button</class>#<selectorId>main</selectorId>[<selectorAttribute>data-kind</selectorAttribute>="hello"]<pseudoClass>:not</pseudoClass>(.<class>disabled</class>)<pseudoElement>::after</pseudoElement> {
          <selectorNesting>&</selectorNesting> <selectorCombinator>></selectorCombinator> <selectorUniversal>*</selectorUniversal><pseudoClass>:first-child</pseudoClass> { color: red; }
        }
        @keyframes <enumMember>spin</enumMember> { to { opacity: 1; } }
    """.trimIndent()
    override fun getAdditionalHighlightingTagToDescriptorMap() = XcssColors.semantic
    override fun getAttributeDescriptors() = XcssColors.semantic.map { (name, key) -> AttributesDescriptor(XcssColors.displayNames.getValue(name), key) }.toTypedArray()
    override fun getColorDescriptors() = ColorDescriptor.EMPTY_ARRAY
}
