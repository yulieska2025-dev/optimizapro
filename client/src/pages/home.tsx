import { useState, useRef, useCallback, useEffect } from "react";
import { Link } from "wouter";
import { Upload, FileText, ImageIcon, X, BarChart2, Loader2, CheckCircle, AlertCircle, TrendingUp, Target, Zap, Download, Crown, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { SignedIn, SignedOut, SignInButton, UserButton, useAuth, useUser } from "@clerk/clerk-react";

type FileType = "image" | "csv" | null;

interface AnalysisResult {
  analysis: string;
}

interface UserStatus {
  email: string | null;
  plan: string;
  analyses_count: number;
}

const FREE_LIMIT = 2;

export default function Home() {
  const { isSignedIn, getToken } = useAuth();
  const { user } = useUser();
  const [file, setFile] = useState<File | null>(null);
  const [fileType, setFileType] = useState<FileType>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [userStatus, setUserStatus] = useState<UserStatus | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();

  const fetchUserStatus = useCallback(async () => {
    if (!isSignedIn) return;
    try {
      const token = await getToken();
      const res = await fetch("/api/user/me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (res.ok) {
        const data = await res.json();
        console.log("[Clerk] /api/user/me:", data);
        setUserStatus({
          email: data.email ?? user?.primaryEmailAddress?.emailAddress ?? null,
          plan: data.plan,
          analyses_count: data.analyses_count,
        });
      }
    } catch (err) {
      console.error("[Clerk] Error fetching user status:", err);
    }
  }, [isSignedIn, getToken, user]);

  useEffect(() => {
    fetchUserStatus();
  }, [fetchUserStatus]);

  // -1 = ilimitado, null = no autenticado
  const analysesLeft = userStatus
    ? userStatus.plan === "free"
      ? Math.max(0, FREE_LIMIT - userStatus.analyses_count)
      : userStatus.plan === "pro"
      ? Math.max(0, 50 - userStatus.analyses_count)
      : -1
    : null;

  const planLimit = userStatus?.plan === "free" ? FREE_LIMIT : userStatus?.plan === "pro" ? 50 : null;

  const isLimitReached =
    userStatus?.plan === "free"
      ? (userStatus?.analyses_count ?? 0) >= FREE_LIMIT
      : userStatus?.plan === "pro"
      ? (userStatus?.analyses_count ?? 0) >= 50
      : false;

  const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
  const ACCEPTED_CSV_TYPES = ["text/csv", "application/vnd.ms-excel"];

  const processFile = useCallback((selectedFile: File) => {
    setResult(null);
    setError(null);

    if (ACCEPTED_IMAGE_TYPES.includes(selectedFile.type)) {
      setFile(selectedFile);
      setFileType("image");
      const url = URL.createObjectURL(selectedFile);
      setPreviewUrl(url);
    } else if (
      ACCEPTED_CSV_TYPES.includes(selectedFile.type) ||
      selectedFile.name.toLowerCase().endsWith(".csv")
    ) {
      setFile(selectedFile);
      setFileType("csv");
      setPreviewUrl(null);
    } else {
      toast({
        title: "Formato no soportado",
        description: "Por favor sube una imagen (JPG, PNG, WEBP) o un archivo CSV.",
        variant: "destructive",
      });
    }
  }, [toast]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    const dropped = e.dataTransfer.files[0];
    if (dropped) processFile(dropped);
  };

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selected = e.target.files?.[0];
    if (selected) processFile(selected);
  };

  const clearFile = () => {
    setFile(null);
    setFileType(null);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setResult(null);
    setError(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const handleAnalyze = async () => {
    if (!file) return;
    setIsAnalyzing(true);
    setResult(null);
    setError(null);

    try {
      const formData = new FormData();
      formData.append("file", file);

      const headers: Record<string, string> = {};
      if (isSignedIn) {
        const token = await getToken();
        if (token) headers["Authorization"] = `Bearer ${token}`;
      }

      const response = await fetch("/api/analyze", {
        method: "POST",
        body: formData,
        headers,
      });

      const data = await response.json();

      if (response.status === 401) {
        throw new Error("Debes iniciar sesión para analizar campañas.");
      }

      if (response.status === 403) {
        throw new Error(data.error ?? "Límite de análisis gratuitos alcanzado. Mejora a premium para continuar.");
      }

      if (!response.ok) {
        throw new Error(data.error ?? `Error del servidor: ${response.status}`);
      }

      setResult(data as AnalysisResult);
      await fetchUserStatus();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Error desconocido";
      setError(msg);
      toast({
        title: "Error al analizar",
        description: msg,
        variant: "destructive",
      });
      await fetchUserStatus();
    } finally {
      setIsAnalyzing(false);
    }
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  const handleDownload = () => {
    if (!result) return;
    const blob = new Blob([result.analysis], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "analisis_optimizapro.txt";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b border-border bg-background/95 backdrop-blur-sm sticky top-0 z-50">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 py-4 flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-md bg-primary">
            <TrendingUp className="w-5 h-5 text-primary-foreground" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-foreground leading-tight">OptimizaPro</h1>
            <p className="text-xs text-muted-foreground leading-tight">Analizador de Campañas Facebook Ads</p>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <span className="hidden sm:inline-flex items-center gap-1.5 text-xs text-muted-foreground bg-muted px-2.5 py-1 rounded-md">
              <Zap className="w-3 h-3 text-primary" />
              IA-Powered
            </span>
            <SignedOut>
              <SignInButton mode="modal">
                <Button variant="outline" size="sm" data-testid="button-signin">
                  Iniciar sesión
                </Button>
              </SignInButton>
            </SignedOut>
            <SignedIn>
              <div className="flex items-center gap-3">
                {userStatus?.plan === "free" && (
                  <Link href="/upgrade">
                    <Button size="sm" className="hidden sm:inline-flex items-center gap-1.5" data-testid="button-upgrade">
                      <Crown className="w-3.5 h-3.5" />
                      Mejorar a Pro
                    </Button>
                  </Link>
                )}
                {userStatus?.plan === "pro" && (
                  <span className="hidden sm:inline-flex items-center gap-1.5 text-xs font-semibold text-amber-600 bg-amber-50 dark:bg-amber-950/30 px-2.5 py-1 rounded-md" data-testid="badge-plan">
                    <Crown className="w-3 h-3" />
                    Plan Pro
                  </span>
                )}
                {userStatus?.plan === "ilimitado" && (
                  <span className="hidden sm:inline-flex items-center gap-1.5 text-xs font-semibold text-violet-600 bg-violet-50 dark:bg-violet-950/30 px-2.5 py-1 rounded-md" data-testid="badge-plan">
                    <Crown className="w-3 h-3" />
                    Plan Agencia
                  </span>
                )}
                <span className="text-xs text-muted-foreground hidden md:inline">
                  {user?.primaryEmailAddress?.emailAddress}
                </span>
                <UserButton afterSignOutUrl="/" />
              </div>
            </SignedIn>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-4 sm:px-6 py-10 sm:py-16">
        <div className="text-center mb-10 sm:mb-14">
          <div className="inline-flex items-center gap-2 bg-primary/10 text-primary px-3.5 py-1.5 rounded-full text-sm font-medium mb-5">
            <BarChart2 className="w-4 h-4" />
            Análisis Inteligente de Campañas
          </div>
          <h2 className="text-3xl sm:text-4xl lg:text-5xl font-bold text-foreground tracking-tight mb-4">
            Optimiza tus campañas con{" "}
            <span className="text-primary">inteligencia</span>
          </h2>
          <p className="text-muted-foreground text-base sm:text-lg max-w-xl mx-auto leading-relaxed">
            Sube una imagen de tu campaña o un archivo CSV con métricas y obtén un análisis detallado en segundos.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
          {[
            { icon: Target, title: "Segmentación", desc: "Identifica las mejores audiencias para tu campaña" },
            { icon: TrendingUp, title: "Rendimiento", desc: "Analiza métricas clave como CTR, CPC y ROAS" },
            { icon: Zap, title: "Optimización", desc: "Recomendaciones automáticas para mejorar resultados" },
          ].map(({ icon: Icon, title, desc }) => (
            <Card key={title} className="p-5 flex gap-4 items-start bg-card border-card-border">
              <div className="w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center flex-shrink-0">
                <Icon className="w-4 h-4 text-primary" />
              </div>
              <div>
                <h3 className="font-semibold text-foreground text-sm mb-0.5">{title}</h3>
                <p className="text-muted-foreground text-xs leading-relaxed">{desc}</p>
              </div>
            </Card>
          ))}
        </div>

        {isSignedIn && userStatus && (
          <Card className="mb-6 border-card-border bg-card" data-testid="card-user-status">
            <div className="px-5 py-4 flex flex-wrap items-center gap-x-6 gap-y-2">
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Usuario:</span>
                <span className="text-xs font-medium text-foreground" data-testid="text-user-email">
                  {userStatus.email ?? "—"}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Plan:</span>
                {userStatus.plan === "free" ? (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-muted-foreground bg-muted px-2 py-0.5 rounded-full" data-testid="text-user-plan">
                    Gratuito
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 text-xs font-semibold text-amber-600 bg-amber-50 dark:bg-amber-950/30 px-2 py-0.5 rounded-full" data-testid="text-user-plan">
                    <Crown className="w-3 h-3" />
                    Premium
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground">Análisis este mes:</span>
                {analysesLeft === -1 ? (
                  <span className="text-xs font-semibold text-violet-600" data-testid="text-analyses-left">Ilimitados</span>
                ) : analysesLeft === null ? (
                  <span className="text-xs font-semibold text-muted-foreground" data-testid="text-analyses-left">—</span>
                ) : (
                  <span
                    className={`text-xs font-semibold ${analysesLeft === 0 ? "text-destructive" : "text-foreground"}`}
                    data-testid="text-analyses-left"
                  >
                    {analysesLeft} de {planLimit} restantes
                  </span>
                )}
              </div>
              {userStatus.plan === "free" && planLimit !== null && (
                <div className="ml-auto flex-shrink-0">
                  <div className="flex gap-1">
                    {Array.from({ length: planLimit }).map((_, i) => (
                      <div
                        key={i}
                        className={`w-2.5 h-2.5 rounded-full ${i < userStatus.analyses_count ? "bg-primary" : "bg-muted border border-border"}`}
                        data-testid={`dot-analysis-${i}`}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
          </Card>
        )}

        <Card className="border-card-border bg-card overflow-visible">
          <div className="p-6 sm:p-8">
            <h3 className="font-semibold text-foreground mb-1">Sube tu archivo</h3>
            <p className="text-muted-foreground text-sm mb-5">
              Acepta imágenes (JPG, PNG, WEBP) y archivos CSV con datos de campañas
            </p>

            <div
              data-testid="dropzone-area"
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              onClick={() => !file && fileInputRef.current?.click()}
              className={[
                "relative border-2 border-dashed rounded-md transition-all duration-200",
                !file ? "cursor-pointer" : "",
                isDragging
                  ? "border-primary bg-primary/5 scale-[1.01]"
                  : file
                  ? "border-primary/30 bg-primary/5"
                  : "border-border bg-muted/30",
                !file ? "hover-elevate" : "",
              ].join(" ")}
              style={{ minHeight: file ? "auto" : "220px" }}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".jpg,.jpeg,.png,.webp,.csv"
                onChange={handleFileSelect}
                className="sr-only"
                data-testid="input-file"
              />

              {!file ? (
                <div className="flex flex-col items-center justify-center p-10 text-center h-full" style={{ minHeight: "220px" }}>
                  <div className={[
                    "w-14 h-14 rounded-full flex items-center justify-center mb-4 transition-colors",
                    isDragging ? "bg-primary text-primary-foreground" : "bg-primary/10 text-primary",
                  ].join(" ")}>
                    <Upload className="w-6 h-6" />
                  </div>
                  <p className="font-semibold text-foreground mb-1">
                    {isDragging ? "Suelta el archivo aquí" : "Arrastra tu archivo aquí"}
                  </p>
                  <p className="text-sm text-muted-foreground mb-4">
                    o haz clic para seleccionarlo
                  </p>
                  <div className="flex flex-wrap gap-2 justify-center">
                    {["JPG", "PNG", "WEBP", "CSV"].map((fmt) => (
                      <span key={fmt} className="text-xs bg-background border border-border px-2 py-1 rounded-md text-muted-foreground font-mono">
                        .{fmt.toLowerCase()}
                      </span>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="p-5">
                  <div className="flex items-start gap-4">
                    {fileType === "image" && previewUrl ? (
                      <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-md border border-border flex-shrink-0 overflow-hidden bg-muted">
                        <img
                          src={previewUrl}
                          alt="Vista previa"
                          className="w-full h-full object-cover"
                          data-testid="img-preview"
                        />
                      </div>
                    ) : (
                      <div className="w-20 h-20 sm:w-24 sm:h-24 rounded-md border border-border flex-shrink-0 bg-primary/10 flex flex-col items-center justify-center gap-1">
                        <FileText className="w-7 h-7 text-primary" />
                        <span className="text-xs font-mono text-primary font-semibold">CSV</span>
                      </div>
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-semibold text-foreground text-sm truncate" data-testid="text-filename">
                            {file.name}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5">
                            {formatFileSize(file.size)}
                          </p>
                          <div className="flex items-center gap-1.5 mt-2">
                            {fileType === "image" ? (
                              <ImageIcon className="w-3.5 h-3.5 text-primary" />
                            ) : (
                              <FileText className="w-3.5 h-3.5 text-primary" />
                            )}
                            <span className="text-xs text-primary font-medium">
                              {fileType === "image" ? "Imagen de campaña" : "Datos CSV"}
                            </span>
                          </div>
                        </div>
                        <button
                          onClick={(e) => { e.stopPropagation(); clearFile(); }}
                          className="flex-shrink-0 w-7 h-7 rounded-md hover-elevate flex items-center justify-center text-muted-foreground bg-muted"
                          data-testid="button-clear-file"
                          aria-label="Eliminar archivo"
                        >
                          <X className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>

                  <button
                    onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                    className="mt-4 text-xs text-muted-foreground hover-elevate underline underline-offset-2 cursor-pointer"
                    data-testid="button-change-file"
                  >
                    Cambiar archivo
                  </button>
                </div>
              )}
            </div>

            <div className="mt-5 flex flex-col gap-3">
              <Button
                size="lg"
                onClick={handleAnalyze}
                disabled={!file || isAnalyzing || isLimitReached}
                className="w-full"
                data-testid="button-analyze"
              >
                {isAnalyzing ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    Analizando campaña...
                  </>
                ) : isLimitReached ? (
                  <>
                    <Lock className="w-4 h-4 mr-2" />
                    Límite mensual alcanzado
                  </>
                ) : (
                  <>
                    <BarChart2 className="w-4 h-4 mr-2" />
                    Analizar Campaña
                  </>
                )}
              </Button>

              {isLimitReached && (
                <div
                  className="flex items-start gap-3 bg-amber-50 dark:bg-amber-950/20 border border-amber-200 dark:border-amber-800 rounded-md px-4 py-3"
                  data-testid="card-limit-reached"
                >
                  <Crown className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                  <div className="text-sm flex-1">
                    <p className="font-semibold text-amber-800 dark:text-amber-300 mb-0.5">
                      Has usado tus {userStatus?.plan === "free" ? 2 : 50} análisis {userStatus?.plan === "free" ? "gratuitos" : "Pro"} de este mes
                    </p>
                    <p className="text-amber-700 dark:text-amber-400 text-xs leading-relaxed">
                      El contador se reinicia automáticamente el próximo mes.{" "}
                      <a
                        href="/upgrade"
                        className="font-semibold underline underline-offset-2 hover:text-amber-900 dark:hover:text-amber-200"
                        data-testid="link-upgrade"
                      >
                        Ver planes Pro y Agencia →
                      </a>
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>
        </Card>

        {result && (
          <Card className="mt-6 border-card-border bg-card" data-testid="card-result">
            <div className="p-6 sm:p-8">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center">
                  <CheckCircle className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground text-sm">Análisis completado</h3>
                  <p className="text-xs text-muted-foreground">Resultado del procesamiento</p>
                </div>
              </div>

              <div className="bg-muted/40 rounded-md p-4 border border-border">
                <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider mb-3">Análisis de IA</p>
                <div
                  className="text-foreground text-sm leading-relaxed whitespace-pre-wrap"
                  data-testid="text-result-analysis"
                >
                  {result.analysis}
                </div>
              </div>

              <div className="mt-5 pt-5 border-t border-border flex flex-col sm:flex-row gap-3">
                <Button
                  className="flex-1 text-white font-semibold border-2"
                  style={{
                    backgroundColor: "#3b82f6",
                    padding: "0.75rem 1.5rem",
                    borderRadius: "8px",
                    display: "inline-block",
                    visibility: "visible",
                    opacity: 1
                  }}
                  onClick={handleDownload}
                  data-testid="button-download-analysis"
                >
                  <Download className="w-4 h-4 mr-2 inline" />
                  Descargar análisis
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={clearFile}
                  className="bg-orange-500 hover:bg-orange-600 text-white border-none"
                  data-testid="button-new-analysis"
                >
                  Nuevo análisis
                </Button>
              </div>
            </div>
          </Card>
        )}

        {error && (
          <Card className="mt-6 border-destructive/30 bg-card" data-testid="card-error">
            <div className="p-6">
              <div className="flex items-center gap-3 mb-3">
                <div className="w-9 h-9 rounded-full bg-destructive/10 flex items-center justify-center">
                  <AlertCircle className="w-5 h-5 text-destructive" />
                </div>
                <div>
                  <h3 className="font-semibold text-foreground text-sm">Error al procesar</h3>
                  <p className="text-xs text-muted-foreground">Ocurrió un problema con el análisis</p>
                </div>
              </div>
              <p className="text-sm text-destructive bg-destructive/10 rounded-md p-3" data-testid="text-error">{error}</p>
            </div>
          </Card>
        )}
      </main>

      <footer className="border-t border-border mt-16 py-8">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 text-center">
          <p className="text-xs text-muted-foreground">
            OptimizaPro &mdash; Analizador de Campañas Facebook Ads &copy; {new Date().getFullYear()}
          </p>
        </div>
      </footer>
    </div>
  );
}
