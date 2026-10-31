/**
 * The Draft workspace — the hero screen. Notice left, reply right, a resizable
 * rule between them.
 *
 * This file is composition and the calls that cross the API boundary; the
 * drafting state machine lives in `useDraft` and the split geometry in
 * `useSplitPane`. Under 1100px the grid becomes one column and the panes stack,
 * per the layout contract, and the divider is removed from the tree entirely
 * rather than hidden — so it cannot be tabbed to when it does nothing.
 */

import { useCallback, useEffect, useState } from "react";

import { EmptyState, Panel, cn, useToast } from "@/components/ui";
import { FileText } from "@/components/icons";
import { NoticePane } from "@/components/app/NoticePane";
import { ReplyDocument } from "@/components/app/ReplyDocument";
import { getModels, getRagDocuments } from "@/lib/api";
import { useDraft } from "@/hooks/useDraft";
import { useSplitPane } from "@/hooks/useSplitPane";
import type { Citation } from "@/lib/citations";
import type { ModelInfo, RagDocument } from "@/types/api";

export type DraftWorkspaceProps = {
  /** Open a citation in the Corpus screen. The shell owns navigation. */
  onOpenCitation?: (citation: Citation) => void;
  /**
   * Whether the model server is up, from the shell's health poll.
   *
   * This used to be read once here on mount and never again, so a backend
   * that was down at startup and came up a second later left the footer
   * saying "The model server isn't running" and the Draft button disabled
   * for the rest of the session -- while the rail, which does poll, said
   * Ready. One poller, one answer.
   */
  modelServerReady: boolean;
  className?: string;
};

export function DraftWorkspace({
  onOpenCitation,
  modelServerReady,
  className
}: DraftWorkspaceProps) {
  const draft = useDraft();
  const { toast } = useToast();
  const { containerRef, isSplit, isResizing, gridStyle, separatorProps } = useSplitPane();

  const [models, setModels] = useState<ModelInfo[]>([]);
  const [corpus, setCorpus] = useState<RagDocument[]>([]);

  // Models fill the Select and the corpus list is what makes a citation
  // verified or not. Both are reads, so each failure degrades the screen
  // rather than blocking it — a CA with the model server down can still read
  // a notice. Health itself comes from the shell (`modelServerReady`).
  useEffect(() => {
    let cancelled = false;

    void (async () => {
      try {
        const listed = await getModels();
        if (!cancelled) {
          setModels(listed.models);
        }
      } catch {
        // `/models` reads the filesystem and never 503s, so reaching here
        // means the backend itself is unreachable -- which the health check
        // above has already reported. An empty list falls back to
        // auto-select.
        if (!cancelled) {
          setModels([]);
        }
      }

      try {
        const documents = await getRagDocuments();
        if (!cancelled) {
          setCorpus(documents);
        }
      } catch {
        if (!cancelled) {
          setCorpus([]);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  const handleOpenOutputFolder = useCallback(async () => {
    const outputFile = draft.draft?.outputFile;
    if (!outputFile) {
      return;
    }
    try {
      // Optional-chained throughout: there is no bridge in a browser dev run.
      const result = await window.localAgent?.openOutputFolder?.(outputFile);
      if (result && result.ok === false) {
        toast({
          tone: "error",
          title: "That folder could not be opened.",
          body: "Find the file under the app's output folder."
        });
      }
    } catch {
      toast({
        tone: "error",
        title: "That folder could not be opened.",
        body: "Find the file under the app's output folder."
      });
    }
  }, [draft.draft, toast]);

  const handleCitationClick = useCallback(
    (citation: Citation) => {
      if (citation.verified === false) {
        // Info tone, not error: an uncited authority is a finding the user
        // must act on, not a failure of the app. The amber on the tag already
        // carries the warning, and vermilion is reserved for errors.
        toast({
          tone: "info",
          title: `${citation.raw} is not in your corpus.`,
          body: "Sync the corpus, or check this citation by hand."
        });
        return;
      }
      onOpenCitation?.(citation);
    },
    [onOpenCitation, toast]
  );

  const replyPane = draft.draft ? (
    <ReplyDocument
      reply={draft.draft.reply}
      modelUsed={draft.draft.modelUsed}
      outputFile={draft.draft.outputFile}
      corpus={corpus}
      onCitationClick={handleCitationClick}
      onOpenOutputFolder={() => void handleOpenOutputFolder()}
      onSave={() => void draft.saveExistingDraft()}
      saving={draft.isSavingDocx}
      className="min-h-0"
    />
  ) : (
    // "Draft", not "Reply": the button says Draft reply, the status says
    // Drafting, and the filled pane's own header says Draft. The empty one
    // has to agree, or the name of the thing changes as it arrives.
    <section className="flex min-h-0 flex-col bg-surface" aria-label="Draft">
      <header className="border-b border-rule px-4 py-3">
        <h2 className="text-base font-medium text-ink">Draft</h2>
      </header>
      <div className="flex min-h-0 flex-1 items-center justify-center px-4 py-12">
        {draft.isDrafting ? (
          // While drafting, the right pane is where the user is looking, so
          // the status lives here too — announced once, not per second.
          <p className="text-sm text-ink-muted" role="status" aria-live="polite">
            Drafting the reply. This can take minutes.
          </p>
        ) : (
          <EmptyState
            icon={<FileText aria-hidden="true" />}
            title={draft.notice ? "Draft a reply to see it here." : "No reply yet."}
            description={
              draft.notice
                ? "Say what the reply should argue, then draft it."
                : "The reply and its citations appear here."
            }
          />
        )}
      </div>
    </section>
  );

  return (
    <div
      ref={containerRef}
      className={cn(
        "grid min-h-0 flex-1 bg-paper",
        isSplit ? "overflow-hidden" : "grid-cols-1 overflow-y-auto",
        className
      )}
      style={gridStyle}
    >
      <Panel className={cn("min-w-0", isSplit ? "min-h-0" : "min-h-[24rem] border-b border-rule")}>
        <NoticePane
          notice={draft.notice}
          isUploading={draft.status === "uploading"}
          isDrafting={draft.isDrafting}
          canDraft={draft.canDraft}
          elapsedSeconds={draft.elapsedSeconds}
          error={draft.error}
          instruction={draft.instruction}
          model={draft.model}
          temperature={draft.temperature}
          saveOutput={draft.saveOutput}
          models={models}
          modelServerReady={modelServerReady}
          onFile={(file) => void draft.acceptFile(file)}
          onClearNotice={draft.clearNotice}
          onInstructionChange={draft.setInstruction}
          onModelChange={draft.setModel}
          onTemperatureChange={draft.setTemperature}
          onSaveOutputChange={draft.setSaveOutput}
          onDraft={() => void draft.draftReply()}
          onCancel={draft.cancelDraft}
          onDismissError={draft.dismissError}
          className="min-h-0"
        />
      </Panel>

      {isSplit ? (
        <div
          {...separatorProps}
          className={cn(
            "relative z-10 cursor-col-resize bg-rule",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-seal",
            isResizing && "bg-seal"
          )}
        >
          {/*
            The divider is a 1px rule per the layout contract, which is far too
            thin to grab. This overlay widens the hit area to 12px without
            widening the rule itself.
          */}
          <span aria-hidden="true" className="absolute inset-y-0 -left-1 -right-1 block" />
        </div>
      ) : null}

      <Panel className={cn("min-w-0", isSplit ? "min-h-0" : "min-h-[24rem]")}>{replyPane}</Panel>
    </div>
  );
}

// The app shell imports this screen as a default; the named export is kept so
// the screen can also be composed directly with props.
export default DraftWorkspace;
