package dev.crossbreeze.jetbrains

import com.intellij.lang.Language
import com.intellij.openapi.fileTypes.LanguageFileType
import com.intellij.icons.AllIcons

object XcssLanguage : Language("XCSS")
class XcssFileType private constructor() : LanguageFileType(XcssLanguage) {
    override fun getName() = "XCSS"
    override fun getDescription() = "XCSS stylesheet"
    override fun getDefaultExtension() = "xcss"
    override fun getIcon() = AllIcons.FileTypes.Css
    companion object { @JvmField val INSTANCE = XcssFileType() }
}
