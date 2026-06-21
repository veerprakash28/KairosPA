# Enabling Push Notifications — Developer Setup Guide

This guide walks you through setting up Firebase Cloud Messaging (FCM) so that ChronosPA can send push notifications to users **even when their browser is closed**.

---

## What You Need

1. A Firebase project with:
   - **Email/Password Authentication** enabled
   - **Firestore Database** created
   - A **Web App** registered in the project
2. Your Firebase **VAPID Key** (Web Push certificate)
3. The Firebase project linked to this repository (for deploying Cloud Functions)

---

## Step 1: Get Your VAPID Key

1. Go to [Firebase Console](https://console.firebase.google.com/) → your project
2. Click the **gear icon** → **Project settings**
3. Go to the **Cloud Messaging** tab
4. Under **Web configuration** → **Web Push certificates**, click **Generate key pair**
5. Copy the **Key pair** value — this is your VAPID key

---

## Step 2: Update `FIREBASE_CONFIG_JSON` in GitHub Secrets

Add `vapidKey` to your existing Firebase config object in GitHub Secrets.

**Settings → Secrets and variables → Actions → Edit `FIREBASE_CONFIG_JSON`**

Update the JSON to include the VAPID key:

```json
{
  "apiKey": "your-api-key",
  "authDomain": "your-project.firebaseapp.com",
  "projectId": "your-project-id",
  "storageBucket": "your-project.appspot.com",
  "messagingSenderId": "123456789",
  "appId": "your-app-id",
  "vapidKey": "YOUR_VAPID_KEY_HERE"
}
```

This config is never committed to git — it is injected into `config.json` at deploy time by the GitHub Actions workflow.

---

## Step 3: Create the Firestore Collection Group Index

The Cloud Function queries `tasks` across all users. This requires a Firestore composite index:

1. Go to **Firestore Database** → **Indexes** tab
2. Click **Add Index**
3. Set:
   - **Collection ID**: `tasks`
   - Field 1: `status` (Ascending)
   - Field 2: `notified` (Ascending)
   - Field 3: `dueTimestamp` (Ascending)
   - **Query scope**: `Collection group`
4. Click **Create**

Wait a few minutes for the index to build before deploying the function.

---

## Step 4: Set Up Firebase CLI & Deploy the Cloud Function

```bash
# Install Firebase CLI globally if you don't have it
npm install -g firebase-tools

# Login to Firebase
firebase login

# In the project root, initialize Firebase (choose Functions + your existing project)
firebase init functions

# Install function dependencies
cd functions && npm install && cd ..

# Deploy only the Cloud Functions
firebase deploy --only functions
```

> **Note:** Cloud Functions are deployed to Firebase's servers — not to GitHub Pages. You only need to deploy them once (or whenever you update `functions/index.js`).

---

## Step 5: Update Firestore Security Rules

Go to **Firestore Database** → **Rules** and add rules to protect user data:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    // Users can only access their own data
    match /users/{userId}/{document=**} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

---

## Step 6: Update `firebase.json` (for GitHub Pages + Functions coexistence)

If you haven't already, create a `firebase.json` in the project root:

```json
{
  "functions": {
    "source": "functions"
  },
  "hosting": {
    "public": ".",
    "ignore": [
      "firebase.json",
      "**/.*",
      "**/node_modules/**",
      "functions/**"
    ]
  }
}
```

---

## How It Works (User Perspective)

1. User signs in to ChronosPA on their phone or laptop
2. They allow browser notifications when prompted
3. Their device is registered for push notifications (silently in the background)
4. When a task is due, the Firebase Cloud Function (running in the cloud) sends a push notification to all the user's signed-in devices
5. The notification appears even if the browser is closed or the device is locked
6. When they open ChronosPA, the task is already shown as notified

---

## Troubleshooting

| Issue | Fix |
|-------|-----|
| Push notifications not arriving | Check VAPID key is correct in config. Check browser notification permissions. |
| "No VAPID key in config" in console | Add `vapidKey` to the GitHub Secret and redeploy |
| Cloud Function failing | Run `firebase functions:log` to see errors |
| Index not ready | Wait for the Firestore index to finish building (Indexes tab) |
| Stale tokens after reinstall | The function auto-cleans invalid tokens on each run |
