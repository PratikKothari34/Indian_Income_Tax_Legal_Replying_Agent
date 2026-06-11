import { useEffect, useRef, useState } from "react";
import { Button, Spinner, Text } from "@fluentui/react-components";
import {
  ArrowUpload24Regular,
  Dismiss20Regular,
  Document24Regular,
  ErrorCircle24Regular
} from "@fluentui/react-icons";
import { uploadFile } from "../lib/api";
import type { UploadError, UploadResponse } from "../types/api";

const ACCEPTED_TYPES = ".pdf,.docx,.xls,.xlsx,.jpg,.jpeg,.png";

type UploadPanelProps = {
  uploadedDocuments: UploadResponse[];
  onAddDocuments: (responses: UploadResponse[]) => void;
  onRemoveDocument: (filename: string) => void;
  onUploadErrorChange: (error: UploadError | null) => void;
  onUploadingChange: (uploading: boolean) => void;
};

export function UploadPanel({
  uploadedDocuments,
  onAddDocuments,
  onRemoveDocument,
  onUploadErrorChange,
  onUploadingChange
}: UploadPanelProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadError, setUploadError] = useState<UploadError | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    onUploadErrorChange(uploadError);
  }, [onUploadErrorChange, uploadError]);

  async function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    setUploadError(null);
    setIsUploading(true);
    onUploadingChange(true);

    // Each /upload call is independent — one bad file can't fail the
    // whole batch, and every per-file backend guard still applies.
    const fileArray = Array.from(files);
    const settled = await Promise.allSettled(fileArray.map((f) => uploadFile(f)));

    const successes: UploadResponse[] = [];
    const failures: { name: string; error: UploadError }[] = [];
    settled.forEach((result, i) => {
      const name = fileArray[i]?.name ?? "(unknown)";
      if (result.status === "fulfilled") {
        successes.push(result.value);
      } else {
        const reason = result.reason;
        const error: UploadError =
          typeof reason === "object" &&
          reason !== null &&
          "code" in reason &&
          "message" in reason
            ? (reason as UploadError)
            : { code: "unknown", message: "Upload failed" };
        failures.push({ name, error });
      }
    });

    if (successes.length > 0) {
      onAddDocuments(successes);
    }
    if (failures.length > 0) {
      const first = failures[0];
      const message =
        failures.length === 1
          ? `${first.name}: ${first.error.message}`
          : `${failures.length} files failed (first: ${first.name} — ${first.error.message})`;
      setUploadError({ code: first.error.code, message, detail: first.error.detail });
    }

    setIsUploading(false);
    onUploadingChange(false);
  }

  return (
    <section className="panel uploadPanel">
      <div className="panelHeader compact">
        <div>
          <Text as="h2" weight="semibold" size={400}>
            Case Files
          </Text>
          <Text size={200} className="mutedText">
            PDF, DOCX, XLS, XLSX, JPG, PNG
          </Text>
        </div>
      </div>

      <div
        className={`dropZone ${isDragging ? "dragging" : ""} ${uploadError ? "hasError" : ""}`}
        onDragEnter={(event) => {
          event.preventDefault();
          setUploadError(null);
          setIsDragging(true);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={(event) => {
          event.preventDefault();
          setIsDragging(false);
        }}
        onDrop={(event) => {
          event.preventDefault();
          setIsDragging(false);
          setUploadError(null);
          void handleFiles(event.dataTransfer.files);
        }}
      >
        <input
          ref={inputRef}
          accept={ACCEPTED_TYPES}
          className="fileInput"
          multiple
          type="file"
          onChange={(event) => {
            setUploadError(null);
            void handleFiles(event.target.files);
            event.currentTarget.value = "";
          }}
        />
        <div className="dropIcon">
          {isUploading ? <Spinner size="tiny" /> : <ArrowUpload24Regular />}
        </div>
        <Text weight="semibold">{isUploading ? "Extracting text..." : "Drag & Drop case files"}</Text>
        <Text size={200} className="mutedText">
          PDF, DOCX, XLS, XLSX, JPG, PNG
        </Text>
        <Button appearance="secondary" disabled={isUploading} onClick={() => inputRef.current?.click()}>
          Browse files
        </Button>
      </div>

      {uploadError && (
        <div className="uploadError" role="alert">
          <ErrorCircle24Regular />
          <span>{uploadError.message}</span>
        </div>
      )}

      {uploadedDocuments.length > 0 && (
        <div className="documentPreviewList">
          {uploadedDocuments.map((doc) => (
            <div className="documentPreview" key={doc.filename}>
              <div className="documentTitle">
                <Document24Regular />
                <Text
                  weight="semibold"
                  style={{
                    flex: 1,
                    minWidth: 0,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap"
                  }}
                >
                  {doc.filename}
                </Text>
                <Button
                  appearance="subtle"
                  size="small"
                  aria-label={`Remove ${doc.filename}`}
                  icon={<Dismiss20Regular />}
                  onClick={() => onRemoveDocument(doc.filename)}
                />
              </div>
              <div className="previewText">
                {doc.text.slice(0, 300)}
                {doc.text.length > 300 ? "..." : ""}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
