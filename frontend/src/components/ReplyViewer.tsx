import { Badge, Button, Text } from "@fluentui/react-components";
import { Document24Regular, FolderOpen24Regular } from "@fluentui/react-icons";
import type { GenerateResponse } from "../types/api";

type ReplyViewerProps = {
  reply: GenerateResponse | null;
  generating: boolean;
};

export function ReplyViewer({ reply, generating }: ReplyViewerProps) {
  async function openFolder() {
    if (reply?.output_file) {
      await window.localAgent.openOutputFolder(reply.output_file);
    }
  }

  return (
    <section className="panel replyPanel">
      <div className="panelHeader">
        <div className="replyTitle">
          <Document24Regular />
          <Text as="h2" weight="semibold" size={500}>
            Generated Legal Reply
          </Text>
        </div>
        {reply?.model_used && <Badge appearance="tint">{reply.model_used}</Badge>}
      </div>

      <div className="draftingNote">
        <Text className="eyebrow">Drafting Notes</Text>
        <Text>
          {reply
            ? "The generated reply is shown below exactly as returned by the local backend."
            : "Upload a notice and describe the legal response you need to begin drafting."}
        </Text>
      </div>

      <div className="replyBox">
        {generating ? (
          <Text className="mutedText">Drafting reply...</Text>
        ) : reply ? (
          <pre>{reply.reply}</pre>
        ) : (
          <Text className="mutedText">Your generated reply will appear here.</Text>
        )}
      </div>

      {reply?.output_file && (
        <div className="exportBar">
          <Text>Saved to {reply.output_file}</Text>
          <Button appearance="secondary" icon={<FolderOpen24Regular />} onClick={openFolder}>
            Open folder
          </Button>
        </div>
      )}
    </section>
  );
}
