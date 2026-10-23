# Discord 2.0

Ein selbst gehosteter Chat im Stil von Discord, mit Servern, Kanälen, Direktnachrichten und Echtzeit-Chat. Dazu kommt eine **Brücke zum echten Discord**:

- **Echten Discord-Servern beitreten:** Discord-Server, in die der Brücken-Bot eingeladen wurde, tauchen in Discord 2.0 unter „Entdecken“ (Kompass-Symbol) auf. Wer beitritt, sieht dort die Kanäle und den Verlauf und kann live mitschreiben.
- **Mit Discord-Nutzern chatten:** In gespiegelten Kanälen erscheinen deine Nachrichten auf Discord unter deinem Namen mit dem Zusatz „(D2)“. Die Antworten der Discord-Nutzer kommen sofort bei dir an. Außerdem kannst du Discord-Nutzern **Direktnachrichten** schicken: Sie bekommen sie vom Bot und können direkt darauf antworten.

## Warum ein Bot und kein normaler Discord-Login?

Discord verbietet in seinen Nutzungsbedingungen inoffizielle Clients und automatisierte normale Nutzerkonten („Self-Bots“), und Konten, die so etwas tun, werden gesperrt. Darum läuft die Verbindung über einen **offiziellen Discord-Bot**, so wie bei den bekannten Matrix-Discord-Brücken. Daraus folgt:

- Ein Discord-Server erscheint erst, wenn jemand mit der Berechtigung „Server verwalten“ den Bot dort einlädt. Das ist gleichzeitig die Zustimmung des Servers, gespiegelt zu werden.
- Direktnachrichten an Discord-Nutzer funktionieren nur, wenn der Nutzer mindestens einen Server mit dem Bot teilt und Direktnachrichten von Servermitgliedern erlaubt.

## Starten

Du brauchst **Node.js 22.13 oder neuer** (die Datenbank nutzt das eingebaute `node:sqlite`).

```bash
npm install
cp .env.example .env   # optional, siehe unten
npm start
```

Dann <http://localhost:3000> öffnen, ein Konto registrieren und loslegen. Ohne Bot-Token läuft alles außer der Discord-Brücke.

## Discord-Bot einrichten

1. Im [Discord Developer Portal](https://discord.com/developers/applications) eine **New Application** anlegen.
2. Unter **Bot**:
   - **Reset Token** klicken und den Token als `DISCORD_BOT_TOKEN` in `.env` eintragen.
   - Unter *Privileged Gateway Intents* **Server Members Intent** und **Message Content Intent** einschalten.
3. Discord 2.0 neu starten. In der Konsole steht dann `[discord] Verbunden als …`.
4. In Discord 2.0 auf den Kompass klicken und den Link **„Bot zu Discord hinzufügen“** öffnen. Darüber kann jeder Discord-Serveradmin seinen Server verbinden. Der Link fragt diese Rechte an: Kanäle ansehen, Nachrichten senden, Nachrichtenverlauf lesen, Webhooks verwalten, Links einbetten und Dateien anhängen.

Der Bot spiegelt alle Text- und Ankündigungskanäle, die er lesen darf. Über die Kanalrechte des Bots auf Discord legst du fest, welche Kanäle sichtbar sind. „Webhooks verwalten“ sorgt dafür, dass Nachrichten aus Discord 2.0 mit dem Namen des Absenders erscheinen. Fehlt das Recht, schreibt der Bot selbst und setzt den Namen vor die Nachricht.

### Konfiguration (`.env`)

| Variable              | Bedeutung                                                                                  |
| --------------------- | ------------------------------------------------------------------------------------------ |
| `PORT`                | Port des Webservers (Standard `3000`)                                                      |
| `DATABASE_FILE`       | Pfad der SQLite-Datenbank (Standard `data/discord2.db`)                                    |
| `DISCORD_BOT_TOKEN`   | Token des Brücken-Bots. Leer bedeutet: keine Brücke                                        |
| `AVATAR_URL_TEMPLATE` | Optionale Bild-URL für Discord-2.0-Nutzer auf Discord, mit `{username}` und `{id}` als Platzhalter |

## Funktionen

- Registrierung und Anmeldung (Passwörter mit scrypt gehasht)
- Eigene Server erstellen, Kanäle anlegen, Freunde per Einladungscode einladen
- Echtzeit-Chat über Socket.IO mit „… schreibt“-Anzeige, Ungelesen-Markierungen und Online-Status
- Direktnachrichten zwischen Discord-2.0-Nutzern
- Discord-Brücke:
  - Discord-Server entdecken und beitreten, Kanäle werden automatisch abgeglichen
  - Nachrichten in beide Richtungen, inklusive Bearbeiten und Löschen auf Discord-Seite
  - Beim ersten Öffnen eines Discord-Kanals werden die letzten 50 Nachrichten geladen
  - Mitgliederliste zeigt Discord-Mitglieder an. Ein Klick darauf startet eine Direktnachricht
  - Nutzersuche über Discord 2.0 und alle verbundenen Discord-Server (auch per Discord-Nutzer-ID)
  - Discord-Anhänge erscheinen als Links bzw. Bilder
  - Aus Discord 2.0 heraus gehen keine `@everyone`- oder Rollen-Pings raus

## Projektaufbau

```
server/
  index.js           Startpunkt (liest .env)
  app.js             Express + Socket.IO zusammenstecken
  db.js              SQLite-Schema
  store.js           Datenzugriff (Nutzer, Server, Kanäle, Nachrichten)
  chat.js            Nachrichten senden/verteilen, Bindeglied zur Brücke
  api.js             REST-API unter /api
  realtime.js        Socket.IO-Ereignisse
  discord-bridge.js  Discord-Bot (discord.js)
public/              Weboberfläche (HTML/CSS/JS ohne Build-Schritt)
test/                Tests (npm test)
```

## Tests

```bash
npm test
```
