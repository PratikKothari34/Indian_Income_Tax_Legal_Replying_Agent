import { useEffect, useRef, useState } from "react";
import { Button, Spinner, Text } from "@fluentui/react-components";
import {
  ArrowUpload24Regular,
  Document24Regular,
  ErrorCircle24Regular
} from "@fluentui/react-icons";
import { uploadFile } from "../lib/api";
import type { UploadError, UploadResponse } from "../types/api";

const ACCEPTED_TYPES = ".pdf,.docx,.xls,.xlsx,.jpg,.jpeg,.png";

type UploadPanelProps = {
  uploadedDocument: UploadResponse | null;
  onUploaded: (response: UploadResponse) => void;
  onUploadErrorChange: (error: UploadError | null) => void;
  onUploadingChange: (uploading: boolean) => void;
};

export function UploadPanel({
  uploadedDocument,
  onUploaded,
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

  async function handleFile(file: File) {
    setUploadError(null);
    setIsUploading(true);
    onUploadingChange(true);

    try {
      const response = await uploadFile(file);
      onUploaded(response);
    } catch (error) {
      const typedError =
        typeof error === "object" && error !== null && "message" in error
          ? (error as UploadError)
          : ({ code: "unknown", message: "Upload failed" } as UploadError);
      setUploadError(typedError);
    } finally {
      setIsUploading(false);
      onUploadingChange(false);
    }
  }

  function handleFiles(files: FileList | null) {
    const file = files?.item(0);
    if (file) {
      void handleFile(file);
    }
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
          handleFiles(event.dataTransfer.files);
        }}
      >
        <input
          ref={inputRef}
          accept={ACCEPTED_TYPES}
          className="fileInput"
          type="file"
          onChange={(event) => {
            setUploadError(null);
            handleFiles(event.target.files);
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

      {uploadedDocument && !uploadError && (
        <div className="documentPreview">
          <div className="documentTitle">
            <Document24Regular />
            <Text weight="semibold">{uploadedDocument.filename}</Text>
          </div>
          <Text className="previewText">
            {uploadedDocument.text.slice(0, 300)}
            {uploadedDocument.text.length > 300 ? "..." : ""}
          </Text>
        </div>
      )}
    </section>
  );
}
