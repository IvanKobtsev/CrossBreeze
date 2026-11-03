package dev.crossbreeze.jetbrains

import com.intellij.extapi.psi.ASTWrapperPsiElement
import com.intellij.lang.ASTNode
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.Document
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.util.TextRange
import com.intellij.platform.lsp.api.LspClientManager
import com.intellij.platform.lsp.api.LspServerState
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiElement
import com.intellij.psi.PsiManager
import com.intellij.psi.PsiReference
import com.intellij.psi.PsiReferenceBase
import org.eclipse.lsp4j.DefinitionParams
import org.eclipse.lsp4j.Position
import java.util.concurrent.CancellationException

/** A lexical reference candidate; the XCSS service owns scope and resolution. */
class XcssSymbolPsiElement(node: ASTNode) : ASTWrapperPsiElement(node) {
    override fun getReference(): PsiReference = XcssSymbolReference(this)
    override fun getReferences(): Array<PsiReference> = arrayOf(reference)
}
private class XcssSymbolReference(element: XcssSymbolPsiElement) :
    PsiReferenceBase<XcssSymbolPsiElement>(element, TextRange(0, element.textLength), true) {
    override fun resolve(): PsiElement? {
        val file = element.containingFile
        if (file.project.isDisposed || ApplicationManager.getApplication().isDispatchThread) return null
        val virtualFile = file.virtualFile ?: return null
        val document = PsiDocumentManager.getInstance(file.project).getDocument(file) ?: return null
        val stamp = document.modificationStamp
        val client = LspClientManager.getInstance(file.project).getClients(CrossBreezeLspIntegrationProvider::class.java)
            .firstOrNull { it.state == LspServerState.Running && it.descriptor.isSupportedFile(virtualFile) } ?: return null
        val offset = element.textRange.startOffset
        val line = document.getLineNumber(offset)
        val params = DefinitionParams(client.getDocumentIdentifier(virtualFile), Position(line, offset - document.getLineStartOffset(line)))
        try {
            val response = client.sendRequestSync(1000) { it.textDocumentService.definition(params) } ?: return null
            if (document.modificationStamp != stamp) return null
            val target = if (response.isRight) response.right.firstOrNull()?.let { it.targetUri to it.targetSelectionRange.start }
                else response.left.firstOrNull()?.let { it.uri to it.range.start }
            val (uri, position) = target ?: return null
            val targetFile = client.descriptor.findFileByUri(uri)?.let { PsiManager.getInstance(file.project).findFile(it) } ?: return null
            val targetDocument = PsiDocumentManager.getInstance(file.project).getDocument(targetFile) ?: return null
            val start = sourceOffset(targetDocument, position) ?: return null
            val leaf = targetFile.findElementAt(start) ?: return null
            return leaf.parent.takeIf { it is XcssSymbolPsiElement } ?: leaf
        } catch (error: ProcessCanceledException) { throw error }
        catch (error: CancellationException) { throw error }
        catch (_: Exception) { return null }
    }
    private fun sourceOffset(document: Document, position: Position): Int? {
        if (position.line !in 0 until document.lineCount || position.character < 0) return null
        val start = document.getLineStartOffset(position.line)
        return (start + position.character).takeIf { it <= document.getLineEndOffset(position.line) }
    }
}
