
const DB_NAME = "ClosetyDatabase";
const DB_VERSION = 1;

let databasePromise;

function openDatabase() {
  if (databasePromise) return databasePromise;

  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;

      if (!db.objectStoreNames.contains("profiles")) {
        db.createObjectStore("profiles", { keyPath: "id" });
      }

      if (!db.objectStoreNames.contains("wardrobes")) {
        db.createObjectStore("wardrobes", { keyPath: "profileId" });
      }

      if (!db.objectStoreNames.contains("images")) {
        const images = db.createObjectStore("images", {
          keyPath: "id",
        });
        images.createIndex("profileId", "profileId");
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      databasePromise = null;
      reject(request.error);
    };
  });

  return databasePromise;
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readAll(storeName) {
  const db = await openDatabase();
  const tx = db.transaction(storeName, "readonly");
  return requestResult(tx.objectStore(storeName).getAll());
}

async function readOne(storeName, key) {
  const db = await openDatabase();
  const tx = db.transaction(storeName, "readonly");
  return requestResult(tx.objectStore(storeName).get(key));
}

async function writeOne(storeName, value) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, "readwrite");
    tx.objectStore(storeName).put(value);

    tx.oncomplete = () => resolve(value);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function makeId() {
  return crypto.randomUUID();
}

// Profiles keep different local wardrobes separate.

export async function getProfiles() {
  return readAll("profiles");
}

export async function createProfile(name) {
  const cleanName = name.trim();

  if (!cleanName) {
    throw new Error("Please enter a profile name.");
  }

  const profile = {
    id: makeId(),
    name: cleanName,
    createdAt: new Date().toISOString(),
  };

  await writeOne("profiles", profile);

  await writeOne("wardrobes", {
    profileId: profile.id,
    root: {
      name: "#RLV/WC",
      type: "root",
      children: [],
    },
    updatedAt: new Date().toISOString(),
  });

  return profile;
}

export async function renameProfile(profileId, name) {
  const profile = await readOne("profiles", profileId);

  if (!profile) throw new Error("Profile not found.");

  profile.name = name.trim();
  await writeOne("profiles", profile);

  return profile;
}

export async function deleteProfile(profileId) {
  const db = await openDatabase();

  return new Promise((resolve, reject) => {
    const tx = db.transaction(
      ["profiles", "wardrobes", "images"],
      "readwrite"
    );

    tx.objectStore("profiles").delete(profileId);
    tx.objectStore("wardrobes").delete(profileId);

    const images = tx.objectStore("images");
    const index = images.index("profileId");
    const request = index.openCursor(
      IDBKeyRange.only(profileId)
    );

    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };

    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Save the folder structure received from the HUD.

export async function saveWardrobe(profileId, root) {
  if (!root || typeof root !== "object") {
    throw new Error("Invalid wardrobe data.");
  }

  return writeOne("wardrobes", {
    profileId,
    root,
    updatedAt: new Date().toISOString(),
  });
}

export async function getWardrobe(profileId) {
  const record = await readOne("wardrobes", profileId);
  return record?.root ?? {
    name: "#RLV/WC",
    type: "root",
    children: [],
  };
}

// Store clothing preview images as files, not base64 in localStorage.

export async function saveImage(
  profileId,
  blob,
  filename,
  itemId = makeId()
) {
  if (!(blob instanceof Blob)) {
    throw new Error("Please select a valid image file.");
  }

  const record = {
    id: `${profileId}:${itemId}`,
    profileId,
    itemId,
    filename: filename || "preview",
    blob,
    updatedAt: new Date().toISOString(),
  };

  await writeOne("images", record);
  return record;
}

export async function getImage(profileId, itemId) {
  return readOne("images", `${profileId}:${itemId}`);
}

export async function getProfileImages(profileId) {
  const db = await openDatabase();
  const tx = db.transaction("images", "readonly");
  const index = tx.objectStore("images").index("profileId");

  return requestResult(index.getAll(
    IDBKeyRange.only(profileId)
  ));
}

export async function deleteImage(profileId, itemId) {
  const db = await openDatabase();
  const tx = db.transaction("images", "readwrite");
  tx.objectStore("images").delete(`${profileId}:${itemId}`);

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Export the complete profile, folder structure and image files.
// The JSON backup can be copied to a USB drive.

function blobToDataURL(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function dataURLToBlob(dataURL) {
  const comma = dataURL.indexOf(",");
  const header = dataURL.slice(0, comma);
  const body = dataURL.slice(comma + 1);
  const mime = header.match(/data:(.*?);base64/)?.[1]
    || "application/octet-stream";

  const binary = atob(body);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return new Blob([bytes], { type: mime });
}

export async function exportBackup(profileId) {
  const profile = await readOne("profiles", profileId);
  const wardrobe = await readOne("wardrobes", profileId);
  const images = await getProfileImages(profileId);

  if (!profile || !wardrobe) {
    throw new Error("Profile or wardrobe not found.");
  }

  const backupImages = [];

  for (const image of images) {
    backupImages.push({
      itemId: image.itemId,
      filename: image.filename,
      data: await blobToDataURL(image.blob),
    });
  }

  const backup = {
    format: "closety-backup",
    version: 1,
    exportedAt: new Date().toISOString(),
    profile: {
      name: profile.name,
    },
    wardrobe: wardrobe.root,
    images: backupImages,
  };

  const blob = new Blob(
    [JSON.stringify(backup, null, 2)],
    { type: "application/json" }
  );

  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `Closety-${profile.name.replace(
    /[^a-z0-9_-]/gi,
    "_"
  )}-backup.json`;

  document.body.appendChild(link);
  link.click();
  link.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export async function importBackup(file) {
  const text = await file.text();
  const backup = JSON.parse(text);

  if (
    backup.format !== "closety-backup" ||
    backup.version !== 1 ||
    !backup.profile?.name ||
    !backup.wardrobe ||
    !Array.isArray(backup.images)
  ) {
    throw new Error("This is not a valid Closety backup.");
  }

  const profile = await createProfile(
    `${backup.profile.name} (Restored)`
  );

  try {
    await saveWardrobe(profile.id, backup.wardrobe);

    for (const image of backup.images) {
      if (!image.itemId || !image.data) continue;

      await saveImage(
        profile.id,
        dataURLToBlob(image.data),
        image.filename || "preview",
        image.itemId
      );
    }
  } catch (error) {
    await deleteProfile(profile.id);
    throw error;
  }

  return profile;
}

// Ask the browser to protect stored data from automatic eviction.
// Users should still export regular backups.

export async function requestPersistentStorage() {
  if (!navigator.storage?.persist) return false;
  return navigator.storage.persist();
}

export async function getStorageEstimate() {
  if (!navigator.storage?.estimate) return null;

  const estimate = await navigator.storage.estimate();

  return {
    usage: estimate.usage ?? 0,
    quota: estimate.quota ?? 0,
  };
}
