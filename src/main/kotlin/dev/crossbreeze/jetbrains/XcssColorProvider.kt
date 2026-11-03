package dev.crossbreeze.jetbrains

import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.command.WriteCommandAction
import com.intellij.openapi.editor.Document
import com.intellij.openapi.editor.ElementColorProvider
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.platform.lsp.api.LspClient
import com.intellij.platform.lsp.api.LspClientManager
import com.intellij.platform.lsp.api.LspServerState
import com.intellij.psi.PsiDocumentManager
import com.intellij.psi.PsiElement
import org.eclipse.lsp4j.ColorInformation
import org.eclipse.lsp4j.ColorPresentationParams
import org.eclipse.lsp4j.DocumentColorParams
import org.eclipse.lsp4j.Position
import java.awt.Color
import java.util.WeakHashMap
import java.util.concurrent.CancellationException

/** Uses the platform's editable color icons; LSP's built-in icons are display-only. */
class XcssColorProvider : ElementColorProvider {
    private data class Cached(val stamp: Long, val clientId: Int, val colors: List<ColorInformation>)
    companion object { private val cache = WeakHashMap<Document, Cached>() }

    private fun client(element: PsiElement): LspClient? {
        val file = element.containingFile ?: return null
        if (file.language != XcssLanguage || file.project.isDisposed) return null
        val virtualFile = file.virtualFile ?: return null
        return LspClientManager.getInstance(file.project).getClients(CrossBreezeLspIntegrationProvider::class.java)
            .firstOrNull { it.state == LspServerState.Running && it.descriptor.isSupportedFile(virtualFile) }
    }
    private fun colors(document: Document, element: PsiElement, client: LspClient): List<ColorInformation> {
        val stamp = document.modificationStamp
        synchronized(cache) { cache[document]?.takeIf { it.stamp == stamp && it.clientId == System.identityHashCode(client) }?.let { return it.colors } }
        if (ApplicationManager.getApplication().isDispatchThread) return emptyList()
        val file = element.containingFile.virtualFile
        val result = client.sendRequestSync(1000) { it.textDocumentService.documentColor(DocumentColorParams(client.getDocumentIdentifier(file))) } ?: return emptyList()
        if (document.modificationStamp != stamp) return emptyList()
        synchronized(cache) { cache[document] = Cached(stamp, System.identityHashCode(client), result) }
        return result
    }
    private fun colorInfo(element: PsiElement, document: Document, client: LspClient): ColorInformation? {
        val start = element.textRange.startOffset
        val line = document.getLineNumber(start)
        val position = Position(line, start - document.getLineStartOffset(line))
        return colors(document, element, client).firstOrNull { it.range.start == position }
    }
    override fun getColorFrom(element: PsiElement): Color? {
        if (element.containingFile?.language != XcssLanguage || element.firstChild != null) return null
        if (element.node?.elementType !in setOf(XcssTokens.IDENTIFIER, XcssTokens.PUNCTUATION, XcssTokens.NUMBER)) return null
        val client = client(element) ?: return null
        val document = PsiDocumentManager.getInstance(element.project).getDocument(element.containingFile) ?: return null
        try {
            val color = colorInfo(element, document, client)?.color ?: return null
            return Color(color.red.toFloat(), color.green.toFloat(), color.blue.toFloat(), color.alpha.toFloat())
        } catch (error: ProcessCanceledException) { throw error }
        catch (error: CancellationException) { throw error }
        catch (_: Exception) { return null }
    }
    override fun setColorTo(element: PsiElement, color: Color) {
        val client = client(element) ?: return
        val project = element.project
        val document = PsiDocumentManager.getInstance(project).getDocument(element.containingFile) ?: return
        val info = colorInfo(element, document, client) ?: return
        val stamp = document.modificationStamp
        val identifier = client.getDocumentIdentifier(element.containingFile.virtualFile)
        val rgba = org.eclipse.lsp4j.Color(color.red / 255.0, color.green / 255.0, color.blue / 255.0, color.alpha / 255.0)
        ApplicationManager.getApplication().executeOnPooledThread {
            try {
                val presentations = client.sendRequestSync(1000) { it.textDocumentService.colorPresentation(ColorPresentationParams(identifier, rgba, info.range)) } ?: return@executeOnPooledThread
                val edit = presentations.firstOrNull()?.textEdit ?: return@executeOnPooledThread
                if (edit.range != info.range) return@executeOnPooledThread
                ApplicationManager.getApplication().invokeLater {
                    if (project.isDisposed || document.modificationStamp != stamp) return@invokeLater
                    val start = document.getLineStartOffset(edit.range.start.line) + edit.range.start.character
                    val end = document.getLineStartOffset(edit.range.end.line) + edit.range.end.character
                    WriteCommandAction.runWriteCommandAction(project, "Change XCSS color", null, Runnable {
                        document.replaceString(start, end, edit.newText)
                        PsiDocumentManager.getInstance(project).commitDocument(document)
                    })
                }
            } catch (error: ProcessCanceledException) { throw error }
            catch (error: CancellationException) { throw error }
            catch (_: Exception) { /* A stale/closed server must not change the document. */ }
        }
    }
}
