package dev.crossbreeze.jetbrains

import com.intellij.lang.ASTNode
import com.intellij.lang.ParserDefinition
import com.intellij.lang.PsiParser
import com.intellij.openapi.project.Project
import com.intellij.psi.FileViewProvider
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiFile
import com.intellij.extapi.psi.ASTWrapperPsiElement
import com.intellij.extapi.psi.PsiFileBase
import com.intellij.psi.tree.IFileElementType
import com.intellij.psi.tree.TokenSet

class XcssParserDefinition : ParserDefinition {
    override fun createLexer(project: Project?) = XcssLexer()
    override fun createParser(project: Project?) = PsiParser { root, builder ->
        val marker = builder.mark()
        while (!builder.eof()) builder.advanceLexer()
        marker.done(root)
        builder.treeBuilt
    }
    override fun getFileNodeType() = FILE
    override fun getCommentTokens() = TokenSet.create(XcssTokens.COMMENT)
    override fun getStringLiteralElements() = TokenSet.create(XcssTokens.STRING)
    override fun createElement(node: ASTNode): PsiElement = ASTWrapperPsiElement(node)
    override fun createFile(viewProvider: FileViewProvider): PsiFile = object : PsiFileBase(viewProvider, XcssLanguage) {
        override fun getFileType() = XcssFileType.INSTANCE
    }
    companion object { private val FILE = IFileElementType(XcssLanguage) }
}
