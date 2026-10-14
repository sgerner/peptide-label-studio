# Vial Label Studio

A small local web app for keeping reusable peptide-vial label records and sending repeated vial labels to a Zebra ZT230 over the network. It uses Node.js' built-in SQLite support and has no npm dependencies.

## Start

Use Node.js 26 or later. From this directory, run:

```sh
npm start
```

The app listens only on this computer at <http://127.0.0.1:3036> and opens that address in the default browser when a desktop session is available. Stop it with Ctrl+C in the terminal. `npm run start:no-browser` starts it without opening a browser.

The database is created on first start at `data/vial-labels.sqlite`. It stays in this directory and is excluded from Git. Use **Export backup** in the app to download a JSON backup of records and print history.

## Create and print records

Add a peptide record, enter the wording and units as you want them printed, and save it. Existing records can be selected, edited, or deleted. Vial cost is saved for reference and is not printed. Dose, dose volume, U-100 syringe marks, dilution, and concentration are stored exactly as entered; the app does not infer missing dilutions or calculate conversions. U-100 syringe marks are a volume scale, not biological IU.

The on-screen design preview is always **2″ wide × 4″ tall**. Choose the number of individual vial labels within each 2″ × 4″ stock label:

- 4 labels gives approximately 1″-tall labels.
- 3 labels gives approximately 1⅓″-tall labels.

Each cut label repeats the selected record and has a cut guide. The print text is sized for these taller strips so the name and details are more legible.

## Prepare the printer

From the Device panel, choose **Find printers** to scan private IPv4 networks attached to this computer for devices with raw ZPL available on port 9100 and a recognizable Zebra status page. Select the matching device and choose **Use selected**. The selection is saved in the local SQLite database. Discovery is read-only: it checks TCP/HTTP availability and does not send print data.

The app sends raw ZPL to the selected printer. It reads that printer's status page before enabling print and adapts each ZPL label to the reported print width and label length. It includes those live dimensions in `^PW` and `^LL` on each print job. The preview remains portrait; when the report is landscape, the app rotates the artwork 90° and lays the cut labels across the printer's reported print-width axis. When the report is portrait, it prints the artwork upright and lays labels along the feed axis. The UI shows the live physical canvas separately from the design preview. The current printer report of about **1200 × 614 dots** is treated as configured media; the app does not force a hard-coded 600 × 1200-dot portrait setup.

The report describes the printer's configured print width (across the printhead) and label length (feed direction); it does not physically sense how the roll is installed. Load and calibrate the intended stock so its physical orientation matches that report, refresh printer status, and verify the preview-to-canvas mapping before confirming print setup. Print remains disabled unless the printer reports READY, both dimensions are readable, and setup is confirmed. Zebra desktop software is not required because the app sends ZPL directly.

Printing submits a job to the printer; the app does not receive a physical completion acknowledgement. If the network connection fails during submission, it marks the job outcome as uncertain and does not retry automatically, to avoid accidental duplicates.

## Settings

The raw ZPL port defaults to 9100. Environment variables can change the app port, ZPL port, or provide a printer host as an initial selection:

```sh
PORT=3036 PRINTER_PORT=9100 npm start
```

The local database is intended to stay on this computer. The server binds to `127.0.0.1` and does not provide remote browser access.
