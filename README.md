# Second Life Closet — Local Starter

A local React/Vite prototype for a personal Second Life wardrobe manager.

## Current prototype
- Sample recursive inventory rooted at `#RLV/CA`
- Categories can contain individual items and nested folders
- Individual items have Wear/Strip demo actions
- Folders have Wear Group/Strip Group/Replace demo actions
- Folder navigation, breadcrumbs, All Objects, All Folders, search and multi-select
- Preview image upload buttons are UI placeholders; Firebase is not connected yet
- Actions are demo notifications only; no Second Life HUD is connected

## Run on Windows
1. Install Node.js LTS from https://nodejs.org/
2. Extract this folder somewhere convenient.
3. Open Command Prompt or PowerShell in the `secondlife-closet` folder.
4. Run:
   ```powershell
   npm install
   npm run dev
   ```
5. Open the local URL Vite prints, normally `http://localhost:5173`.

## Next implementation steps
1. Add Firebase project configuration and Authentication.
2. Add Firestore inventory persistence and Firebase Storage preview uploads.
3. Define the inventory scan/import format.
4. Build a secure, reachable communication route between the local site and the Second Life HUD. `localhost` alone is not reachable from a Second Life script.
5. Implement and test RLV folder/item operations with the target viewer.

Do not put Firebase Admin credentials or service-account JSON in frontend code. Firebase web configuration is intended for client use; secure data with Authentication and Firestore/Storage Security Rules.
