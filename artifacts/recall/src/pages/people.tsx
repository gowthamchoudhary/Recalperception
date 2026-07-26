import { useState, useRef } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { AppShell } from "@/components/layout/AppShell";
import { Button, Card } from "@/components/ui";
import {
  useListEnrolledPeople,
  useEnrollPerson,
  useUpdateEnrolledPerson,
  useDeleteEnrolledPerson,
  getListEnrolledPeopleQueryKey,
} from "@workspace/api-client-react";
import {
  ChevronLeft,
  ScanFace,
  UserPlus,
  Pencil,
  Trash2,
  Loader2,
  Check,
  X,
  ImagePlus,
} from "lucide-react";

/**
 * Reference photos are downscaled in the browser before upload: plenty of
 * pixels for face indexing, small enough to store/display as a data URL.
 */
async function downscalePhoto(file: File): Promise<File> {
  const MAX_EDGE = 1000;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const alreadySmall =
      scale === 1 &&
      file.size < 1_500_000 &&
      (file.type === "image/jpeg" || file.type === "image/png");
    if (alreadySmall) return file;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.87),
    );
    if (!blob) return file;
    return new File([blob], "photo.jpg", { type: "image/jpeg" });
  } catch {
    // Format the browser can't decode (e.g. HEIC) — let the server validate.
    return file;
  }
}

function EnrollForm() {
  const [name, setName] = useState("");
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const queryClient = useQueryClient();
  const enroll = useEnrollPerson();

  const reset = () => {
    setName("");
    setPhoto(null);
    setPreview(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const onPickPhoto = (file: File | null) => {
    setError(null);
    setPhoto(file);
    setPreview((old) => {
      if (old) URL.revokeObjectURL(old);
      return file ? URL.createObjectURL(file) : null;
    });
  };

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !photo || enroll.isPending) return;
    setError(null);
    try {
      const prepared = await downscalePhoto(photo);
      await enroll.mutateAsync({ data: { name: name.trim(), photo: prepared } });
      await queryClient.invalidateQueries({
        queryKey: getListEnrolledPeopleQueryKey(),
      });
      reset();
    } catch (err) {
      setError(
        (err as { message?: string })?.message ||
          "Could not enroll this person. Try again.",
      );
    }
  };

  return (
    <Card className="p-6 md:p-8 rounded-[24px] border-border/60 mb-12">
      <h2 className="text-lg font-extrabold mb-1 flex items-center gap-2">
        <UserPlus className="w-5 h-5 text-accent" /> Add a person
      </h2>
      <p className="text-sm font-medium text-muted-foreground mb-6">
        Upload one clear, front-facing photo. Recall uses it to recognize this
        person in your videos when you search for them by name.
      </p>
      <form onSubmit={onSubmit} className="flex flex-col sm:flex-row gap-6 sm:items-end">
        <div className="shrink-0">
          <input
            ref={fileInputRef}
            id="person-photo"
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            onChange={(e) => onPickPhoto(e.target.files?.[0] ?? null)}
            data-testid="person-photo-input"
          />
          <label
            htmlFor="person-photo"
            className="w-28 h-28 rounded-2xl border-2 border-dashed border-border hover:border-accent bg-secondary/40 flex items-center justify-center cursor-pointer overflow-hidden transition-colors"
          >
            {preview ? (
              <img src={preview} alt="Reference preview" className="w-full h-full object-cover" />
            ) : (
              <ImagePlus className="w-8 h-8 text-muted-foreground" />
            )}
          </label>
        </div>
        <div className="flex-1">
          <label htmlFor="person-name" className="block text-xs font-bold text-muted-foreground uppercase tracking-widest mb-2">
            Name
          </label>
          <input
            id="person-name"
            type="text"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Anaya"
            className="w-full h-12 px-5 rounded-full bg-card border border-border font-medium focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-all"
            data-testid="person-name-input"
          />
        </div>
        <Button
          type="submit"
          disabled={!name.trim() || !photo || enroll.isPending}
          className="rounded-full font-bold px-8 h-12"
          data-testid="enroll-person-button"
        >
          {enroll.isPending ? (
            <><Loader2 className="w-4 h-4 mr-2 animate-spin" /> Indexing face…</>
          ) : (
            "Add person"
          )}
        </Button>
      </form>
      {error && (
        <p className="mt-4 text-sm font-semibold text-red-600" data-testid="enroll-error">
          {error}
        </p>
      )}
    </Card>
  );
}

function PersonCard({
  person,
}: {
  person: { id: number; name: string; thumbnailUrl: string; createdAt: string };
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(person.name);
  const queryClient = useQueryClient();
  const update = useUpdateEnrolledPerson();
  const remove = useDeleteEnrolledPerson();

  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: getListEnrolledPeopleQueryKey() });

  const saveName = async () => {
    const name = draft.trim();
    if (!name || name === person.name) {
      setEditing(false);
      setDraft(person.name);
      return;
    }
    await update.mutateAsync({ id: person.id, data: { name } });
    await refresh();
    setEditing(false);
  };

  const deletePerson = async () => {
    if (!window.confirm(`Remove ${person.name}? Searches will no longer match their face.`)) return;
    await remove.mutateAsync({ id: person.id });
    await refresh();
  };

  return (
    <Card className="rounded-[20px] overflow-hidden border-border/60 group" data-testid={`person-card-${person.id}`}>
      <div className="aspect-square bg-secondary relative">
        {person.thumbnailUrl ? (
          <img src={person.thumbnailUrl} alt={person.name} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-muted-foreground/40">
            <ScanFace className="w-10 h-10" />
          </div>
        )}
        <div className="absolute top-2 right-2 flex gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
          <button
            type="button"
            aria-label={`Rename ${person.name}`}
            onClick={() => setEditing(true)}
            className="w-8 h-8 rounded-full bg-black/55 backdrop-blur-md text-white flex items-center justify-center hover:bg-black/75 transition-colors"
            data-testid={`rename-person-${person.id}`}
          >
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            aria-label={`Delete ${person.name}`}
            onClick={() => void deletePerson()}
            disabled={remove.isPending}
            className="w-8 h-8 rounded-full bg-black/55 backdrop-blur-md text-white flex items-center justify-center hover:bg-red-600/90 transition-colors"
            data-testid={`delete-person-${person.id}`}
          >
            {remove.isPending ? (
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
            ) : (
              <Trash2 className="w-3.5 h-3.5" />
            )}
          </button>
        </div>
      </div>
      <div className="p-4">
        {editing ? (
          <div className="flex items-center gap-2">
            <input
              autoFocus
              value={draft}
              maxLength={80}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveName();
                if (e.key === "Escape") { setEditing(false); setDraft(person.name); }
              }}
              className="w-full h-9 px-3 rounded-lg bg-secondary/60 border border-border text-sm font-bold focus:outline-none focus:ring-2 focus:ring-accent"
              data-testid={`rename-input-${person.id}`}
            />
            <button
              type="button"
              aria-label="Save name"
              onClick={() => void saveName()}
              disabled={update.isPending}
              className="w-8 h-8 shrink-0 rounded-full bg-accent text-accent-foreground flex items-center justify-center"
            >
              {update.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-4 h-4" />}
            </button>
            <button
              type="button"
              aria-label="Cancel rename"
              onClick={() => { setEditing(false); setDraft(person.name); }}
              className="w-8 h-8 shrink-0 rounded-full bg-secondary text-muted-foreground flex items-center justify-center"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : (
          <p className="font-extrabold truncate" data-testid={`person-name-${person.id}`}>{person.name}</p>
        )}
      </div>
    </Card>
  );
}

export default function People() {
  const { data: people, isLoading } = useListEnrolledPeople();

  return (
    <AppShell>
      <main className="flex-1 max-w-[1000px] w-full mx-auto px-6 md:px-10 py-12 pb-24">
        <div className="mb-10">
          <h1 className="text-4xl font-extrabold tracking-tight mb-3 flex items-center gap-3">
            <ScanFace className="w-9 h-9 text-accent" /> People
          </h1>
          <p className="text-lg font-medium text-muted-foreground max-w-2xl">
            Teach Recall who's who. Once someone is added, searches like{" "}
            <span className="text-foreground font-semibold">"Anaya blowing out candles"</span>{" "}
            only return moments where their face is actually in frame.
          </p>
        </div>

        <EnrollForm />

        {isLoading ? (
          <div className="flex justify-center py-20">
            <div className="w-10 h-10 border-4 border-secondary border-t-accent rounded-full animate-spin" />
          </div>
        ) : !people || people.length === 0 ? (
          <div className="py-16 text-center border-2 border-dashed border-border rounded-[24px]">
            <ScanFace className="w-12 h-12 text-muted-foreground/40 mx-auto mb-4" />
            <p className="text-lg font-bold text-muted-foreground">Nobody enrolled yet</p>
            <p className="text-sm font-medium text-muted-foreground/80 mt-1">
              Add someone above to unlock person-based search.
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-6">
            {people.map((p) => (
              <PersonCard key={p.id} person={p} />
            ))}
          </div>
        )}
      </main>
    </AppShell>
  );
}
