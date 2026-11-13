package dev.crossbreeze.jetbrains

import com.intellij.codeInsight.navigation.actions.GotoDeclarationHandler
import com.intellij.find.actions.FindUsagesAction
import com.intellij.openapi.actionSystem.ActionManager
import com.intellij.openapi.actionSystem.ActionPlaces
import com.intellij.openapi.actionSystem.ActionUiKind
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.actionSystem.CommonDataKeys
import com.intellij.openapi.actionSystem.ex.ActionUtil
import com.intellij.openapi.actionSystem.impl.SimpleDataContext
import com.intellij.find.usages.api.*
import com.intellij.model.Pointer
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.editor.Editor
import com.intellij.openapi.fileEditor.OpenFileDescriptor
import com.intellij.openapi.progress.ProcessCanceledException
import com.intellij.openapi.util.TextRange
import com.intellij.platform.backend.presentation.TargetPresentation
import com.intellij.platform.lsp.api.LspClientManager
import com.intellij.platform.lsp.api.LspServerState
import com.intellij.psi.*
import com.intellij.psi.impl.FakePsiElement
import com.intellij.usages.UsageView
import com.intellij.util.Query
import org.eclipse.lsp4j.*
import java.util.concurrent.CancellationException
import java.util.concurrent.CompletableFuture

interface CrossBreezeLanguageServer : org.eclipse.lsp4j.services.LanguageServer {
    @org.eclipse.lsp4j.jsonrpc.services.JsonRequest("crossbreeze/navigation")
    fun navigation(params: TextDocumentPositionParams): CompletableFuture<List<Location>>
}

/** Use the usages UI for multiple navigation targets, including declarations. */
class XcssNavigationHandler : GotoDeclarationHandler {
    override fun getGotoDeclarationTargets(sourceElement: PsiElement?, offset: Int, editor: Editor): Array<PsiElement>? {
        val file = sourceElement?.containingFile ?: return null
        val virtualFile = file.virtualFile ?: return null
        if (virtualFile.extension !in setOf("xcss", "ts", "tsx", "mts", "cts")) return null
        if (ApplicationManager.getApplication().isDispatchThread) return null
        val client = LspClientManager.getInstance(file.project).getClients(CrossBreezeLspIntegrationProvider::class.java)
            .firstOrNull { it.state == LspServerState.Running && it.descriptor.isSupportedFile(virtualFile) } ?: return null
        val document = editor.document
        val stamp = document.modificationStamp
        val line = document.getLineNumber(offset)
        val params = TextDocumentPositionParams(client.getDocumentIdentifier(virtualFile), Position(line, offset - document.getLineStartOffset(line)))
        val locations = try {
            client.sendRequestSync(3000) {
                (it as CrossBreezeLanguageServer).navigation(params)
            }
        } catch (error: ProcessCanceledException) { throw error }
        catch (error: CancellationException) { throw error }
        catch (_: Exception) { return null }
        if (document.modificationStamp != stamp) return null
        val targets = locations ?: return null
        // Asset definitions point to the file itself; binary files have no PSI document.
        val asset = targets.singleOrNull()?.takeIf {
            it.range.start.line == 0 && it.range.start.character == 0 && it.range.end == it.range.start
        }?.let { client.descriptor.findFileByUri(it.uri) }
        if (asset != null) return arrayOf(object : FakePsiElement() {
            override fun getParent(): PsiElement = sourceElement
            override fun getName() = asset.name
            override fun canNavigate() = true
            override fun canNavigateToSource() = true
            override fun navigate(requestFocus: Boolean) {
                OpenFileDescriptor(file.project, asset).navigate(requestFocus)
            }
        })
        val usages = targets.mapNotNull { location ->
            val targetFile = client.descriptor.findFileByUri(location.uri)?.let { PsiManager.getInstance(file.project).findFile(it) } ?: return@mapNotNull null
            val targetDocument = PsiDocumentManager.getInstance(file.project).getDocument(targetFile) ?: return@mapNotNull null
            fun toOffset(position: Position): Int? = if (position.line in 0 until targetDocument.lineCount && position.character >= 0)
                (targetDocument.getLineStartOffset(position.line) + position.character).takeIf { it <= targetDocument.getLineEndOffset(position.line) } else null
            val start = toOffset(location.range.start) ?: return@mapNotNull null
            val end = toOffset(location.range.end) ?: return@mapNotNull null
            if (end < start) return@mapNotNull null
            PsiUsage.textUsage(targetFile, TextRange(start, end))
        }
        if (usages.isEmpty()) return if (virtualFile.extension == "xcss") emptyArray() else null
        return arrayOf(object : FakePsiElement() {
            override fun getParent(): PsiElement = sourceElement
            override fun getName() = sourceElement.text
            override fun canNavigate() = true
            override fun canNavigateToSource() = true
            override fun navigate(requestFocus: Boolean) {
                if (usages.size == 1) {
                    val usage = usages.single()
                    OpenFileDescriptor(file.project, usage.file.virtualFile, usage.range.startOffset).navigate(requestFocus)
                } else {
                    val context = SimpleDataContext.builder()
                        .add(CommonDataKeys.PROJECT, file.project)
                        .add(CommonDataKeys.EDITOR, editor)
                        .add(FindUsagesAction.SEARCH_TARGETS, listOf(XcssNavigationTarget(usages, name ?: "XCSS")))
                        .add(UsageView.USAGE_TARGETS_KEY, emptyArray())
                        .build()
                    val action = ActionManager.getInstance().getAction("ShowUsages")
                    val event = AnActionEvent.createEvent(action, context, null, ActionPlaces.UNKNOWN, ActionUiKind.NONE, null)
                    ActionUtil.performAction(action, event)
                }
            }
        })
    }
}

private data class XcssNavigationTarget(val usages: List<PsiUsage>, val name: String) : SearchTarget {
    override fun createPointer(): Pointer<out SearchTarget> = Pointer.hardPointer(this)
    override fun presentation() = TargetPresentation.builder(name).presentation()
    override val usageHandler: UsageHandler get() = UsageHandler.createEmptyUsageHandler(name)
}

class XcssNavigationUsageSearcher : UsageSearcher {
    override fun collectImmediateResults(parameters: UsageSearchParameters): Collection<Usage> =
        (parameters.target as? XcssNavigationTarget)?.usages ?: emptyList()
    // Explicit implementations avoid Kotlin bridges invoking @OverrideOnly defaults.
    override fun collectSearchRequests(parameters: UsageSearchParameters): Collection<Query<out Usage>> = emptyList()
    override fun collectSearchRequest(parameters: UsageSearchParameters): Query<out Usage>? = null
}
