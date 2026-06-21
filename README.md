# ChronosPA — Personal Assistant & Task Dashboard

A premium glassmorphic personal assistant web app for managing tasks, schedules, and reminders across all your devices.

## Features

- **Smart Task Management** — Create, reschedule, complete, and delete tasks with a beautiful timeline view
- **Conversational Assistant** — Type natural commands like `remind me to stretch in 10 mins` or `add task report at 15:30`
- **Monthly Calendar** — Visual calendar with task indicators and day-by-day preview
- **Carry Forward** — Automatically detect overdue tasks and reschedule them to today
- **Desktop Notifications** — Get browser alerts when your tasks are due
- **Multi-Device Sync** — Sign in once, access your tasks from any device (when Firebase is configured)
- **Mobile Friendly** — Fully responsive design with slide-out assistant panel

## Live Demo

Visit the deployed app: [ChronosPA on GitHub Pages](https://veerprakash28.github.io/ChronosPA/)

## Running Locally

1. Clone this repository
2. Open the project folder
3. Start a local server:
   ```bash
   python3 -m http.server 8080
   ```
4. Open `http://localhost:8080` in your browser

> **Note:** Without Firebase configuration, the app works in local-only mode using your browser's localStorage. Your tasks won't sync across devices.

## Setting Up Multi-Device Sync (Firebase)

To enable sign-in and cross-device sync:

### 1. Create a Firebase Project
- Go to [Firebase Console](https://console.firebase.google.com/)
- Click **Add project** and follow the setup wizard
- Register a **Web app** in your project settings

### 2. Enable Authentication
- In Firebase Console → **Authentication** → **Sign-in method**
- Enable **Email/Password** provider

### 3. Create Firestore Database
- In Firebase Console → **Firestore Database** → **Create database**
- Start in **test mode** (you can add security rules later)

### 4. Deploy with GitHub Actions
- In your GitHub repository: **Settings** → **Secrets and variables** → **Actions**
- Add a new secret named `FIREBASE_CONFIG_JSON` with your Firebase config:
  ```json
  {
    "apiKey": "your-api-key",
    "authDomain": "your-project.firebaseapp.com",
    "projectId": "your-project-id",
    "storageBucket": "your-project.appspot.com",
    "messagingSenderId": "123456789",
    "appId": "your-app-id"
  }
  ```
- Change **Settings** → **Pages** → **Source** to `GitHub Actions`
- Push to `main` — the workflow will automatically deploy with your config

## Tech Stack

- HTML5, CSS3, Vanilla JavaScript
- Firebase Authentication & Firestore (optional)
- GitHub Pages + GitHub Actions CI/CD

## License

MIT
