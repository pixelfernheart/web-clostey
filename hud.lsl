
/*
    CLOSETY HUD - FRESH BUILD
    Inventory root: #RLV/WC

    Menu:
      CONNECT - pair with the Closety website
      SCAN    - discover folders and upload them
      HELP    - setup instructions

    Requires:
      - Firestorm or another viewer with RLVa/RLV enabled
      - A Closety_Config notecard
      - A deployed Closety website and hud-sync function

    Important:
      - Server folder paths are RELATIVE to #RLV/WC.
      - RLV request paths are RELATIVE to #RLV.
*/

string CONFIG_CARD = "Closety_Config";

string WEBSITE_URL = "";
string INVENTORY_ROOT = "WC";

key gAvatar;
key gNotecardRequest;

integer gConfigLine = 0;
integer gConfigReading = FALSE;
integer gPaired = FALSE;

key gPairToken;

integer gDialogChannel;
integer gDialogListen;
integer gRLVChannel;
integer gRLVListen;

integer gScanning = FALSE;
integer gWaitingForRLV = FALSE;
integer gUploading = FALSE;
integer gScanHadTimeout = FALSE;

string gCurrentFolder = "";
list gFolderQueue = [];
list gFolderPaths = [];

integer gUploadIndex = 0;
integer gChunkSize = 8;

integer gNextCommandPoll = 0;
integer gCommandPollInFlight = FALSE;

integer gRLVDeadline = 0;

integer gWornQueryInFlight = FALSE;
integer gWornQueryIndex = 0;
list gOutfitCandidates = [];
list gWornOutfits = [];

list gHTTPIds = [];
list gHTTPActions = [];


// --------------------------------------------------
// General helpers
// --------------------------------------------------

string trimSlash(string value)
{
    integer length = llStringLength(value);

    while (
        length > 0 &&
        llGetSubString(value, length - 1, length - 1) == "/"
    )
    {
        value = llDeleteSubString(
            value,
            length - 1,
            length - 1
        );

        length = llStringLength(value);
    }

    return value;
}

string rootPath()
{
    return INVENTORY_ROOT;
}

// Converts an RLV path such as WC/Casual into
// a website path such as Casual.
string relativeFromRLV(string fullPath)
{
    string prefix = rootPath() + "/";

    if (llSubStringIndex(fullPath, prefix) == 0)
    {
        return llGetSubString(
            fullPath,
            llStringLength(prefix),
            -1
        );
    }

    return "";
}

// Converts a website-relative path into an RLV path.
string fullRLVPath(string relativePath)
{
    relativePath = llStringTrim(
        relativePath,
        STRING_TRIM
    );

    if (relativePath == "")
        return rootPath();

    return rootPath() + "/" + relativePath;
}

integer validRelativePath(string path)
{
    list parts = llParseStringKeepNulls(
        path,
        ["/"],
        []
    );

    integer i;
    integer count = llGetListLength(parts);

    if (path == "")
        return FALSE;

    for (i = 0; i < count; ++i)
    {
        string part = llList2String(parts, i);

        if (
            part == "" ||
            part == "." ||
            part == ".."
        )
        {
            return FALSE;
        }
    }

    return TRUE;
}

string makeJSON(list pairs)
{
    return llList2Json(JSON_OBJECT, pairs);
}


// --------------------------------------------------
// Website HTTP helpers
// --------------------------------------------------

key sendPOST(string action, string body)
{
    key requestId = llHTTPRequest(
        trimSlash(WEBSITE_URL) + "/api/hud-sync",
        [
            HTTP_METHOD, "POST",
            HTTP_MIMETYPE, "application/json",
            HTTP_VERIFY_CERT, TRUE
        ],
        body
    );

    gHTTPIds += [requestId];
    gHTTPActions += [action];

    return requestId;
}

key sendGET(string action, string url)
{
    key requestId = llHTTPRequest(
        url,
        [
            HTTP_METHOD, "GET",
            HTTP_VERIFY_CERT, TRUE
        ],
        ""
    );

    gHTTPIds += [requestId];
    gHTTPActions += [action];

    return requestId;
}

sendCommandResult(
    string commandId,
    integer success,
    string message
)
{
    string body = makeJSON([
        "action", "command_result",
        "token", (string)gPairToken,
        "commandId", commandId,
        "success", success,
        "message", message
    ]);

    sendPOST("command_result", body);
}

integer beginCommandPoll()
{
    if (!gPaired || gCommandPollInFlight)
        return FALSE;

    gCommandPollInFlight = TRUE;
    gNextCommandPoll = llGetUnixTime() + 8;

    string url =
        trimSlash(WEBSITE_URL)
        + "/api/hud-sync?action=next_command&token="
        + llEscapeURL((string)gPairToken);

    sendGET("next_command", url);

    return TRUE;
}


// --------------------------------------------------
// Configuration notecard
// --------------------------------------------------

readConfiguration()
{
    if (
        llGetInventoryType(CONFIG_CARD)
        != INVENTORY_NOTECARD
    )
    {
        gConfigReading = FALSE;

        llOwnerSay(
            "Closety: missing notecard "
            + CONFIG_CARD
            + ". Create it and add WEBSITE_URL and INVENTORY_ROOT."
        );

        return;
    }

    gConfigLine = 0;
    gConfigReading = TRUE;

    gNotecardRequest = llGetNotecardLine(
        CONFIG_CARD,
        gConfigLine
    );
}

processConfigLine(string line)
{
    line = llStringTrim(line, STRING_TRIM);

    if (
        line == "" ||
        llGetSubString(line, 0, 0) == "#"
    )
    {
        return;
    }

    integer splitAt = llSubStringIndex(line, "=");

    if (splitAt < 0)
        return;

    string setting = llStringTrim(
        llGetSubString(line, 0, splitAt - 1),
        STRING_TRIM
    );

    string value = llStringTrim(
        llGetSubString(line, splitAt + 1, -1),
        STRING_TRIM
    );

    if (setting == "WEBSITE_URL")
    {
        WEBSITE_URL = trimSlash(value);
    }
    else if (setting == "INVENTORY_ROOT")
    {
        INVENTORY_ROOT = value;
    }
}


// --------------------------------------------------
// HUD menu
// --------------------------------------------------

showMenu()
{
    llDialog(
        gAvatar,
        "CLOSETY\n\n"
        + "CONNECT - pair with your website\n"
        + "SCAN - discover #RLV/" + INVENTORY_ROOT + "\n"
        + "HELP - setup information",
        ["CONNECT", "SCAN", "HELP"],
        gDialogChannel
    );
}

showHelp()
{
    llOwnerSay(
        "Closety Help\n"
        + "1. Enable RLVa/RLV in your viewer.\n"
        + "2. Make sure #RLV/" + INVENTORY_ROOT
        + " exists in your inventory.\n"
        + "3. Wear this HUD.\n"
        + "4. Click CONNECT and open the website.\n"
        + "5. Click SCAN and wait for completion.\n"
        + "6. Click Refresh on the website.\n"
        + "Keep the HUD attached while using website commands."
    );
}


// --------------------------------------------------
// Pairing
// --------------------------------------------------

startPairing()
{
    if (WEBSITE_URL == "")
    {
        llOwnerSay(
            "Closety: WEBSITE_URL is missing from "
            + CONFIG_CARD + "."
        );

        return;
    }

    gPairToken = llGenerateKey();
    gPaired = FALSE;

    string body = makeJSON([
        "action", "pair",
        "token", (string)gPairToken,
        "avatarUUID", (string)gAvatar,
        "avatarName", llKey2Name(gAvatar)
    ]);

    sendPOST("pair", body);

    llOwnerSay("Closety: connecting to your website...");
}


// --------------------------------------------------
// Folder scan
// --------------------------------------------------

startScan()
{
    if (!gPaired)
    {
        llOwnerSay(
            "Closety: click CONNECT first."
        );

        return;
    }

    if (
        gScanning ||
        gUploading ||
        gWornQueryInFlight
    )
    {
        llOwnerSay(
            "Closety: another scan is already running."
        );

        return;
    }

    gScanning = TRUE;
    gWaitingForRLV = FALSE;
    gUploading = FALSE;
    gScanHadTimeout = FALSE;

    gFolderQueue = [rootPath()];
    gFolderPaths = [];

    gCurrentFolder = "";
    gUploadIndex = 0;

    llOwnerSay(
        "Closety: starting folder scan..."
    );

    string body = makeJSON([
        "action", "scan_start",
        "token", (string)gPairToken
    ]);

    sendPOST("scan_start", body);
}

queryNextFolder()
{
    if (!gScanning || gWaitingForRLV)
        return;

    if (llGetListLength(gFolderQueue) == 0)
    {
        gScanning = FALSE;
        gUploading = TRUE;
        gUploadIndex = 0;

        llOwnerSay(
            "Closety: folder discovery finished. "
            + "Uploading the results..."
        );

        uploadNextChunk();
        return;
    }

    // Queue contains paths relative to #RLV,
    // for example WC and WC/Casual.
    gCurrentFolder = llList2String(
        gFolderQueue,
        0
    );

    gFolderQueue = llDeleteSubList(
        gFolderQueue,
        0,
        0
    );

    gWaitingForRLV = TRUE;
    gRLVDeadline = llGetUnixTime() + 8;

    // @getinv paths are relative to #RLV.
    llOwnerSay(
        "@getinv:"
        + gCurrentFolder
        + "="
        + (string)gRLVChannel
    );
}

handleFolderResponse(string message)
{
    if (!gScanning || !gWaitingForRLV)
        return;

    gWaitingForRLV = FALSE;

    message = llStringTrim(
        message,
        STRING_TRIM
    );

    if (message != "")
    {
        list childNames = llParseStringKeepNulls(
            message,
            [","],
            []
        );

        integer i;
        integer count = llGetListLength(childNames);

        for (i = 0; i < count; ++i)
        {
            string child = llStringTrim(
                llList2String(childNames, i),
                STRING_TRIM
            );

            if (child == "")
                jump continue_child;

            if (llGetSubString(child, 0, 0) == ".")
                jump continue_child;

            // Full path used only for RLV requests.
            string fullPath =
                gCurrentFolder + "/" + child;

            // Website path is relative to #RLV/WC.
            string relativePath =
                relativeFromRLV(fullPath);

            if (
                relativePath != "" &&
                llListFindList(
                    gFolderPaths,
                    [relativePath]
                ) == -1
            )
            {
                gFolderPaths += [relativePath];

                // Continue scanning using the full RLV path.
                gFolderQueue += [fullPath];
            }

@continue_child;
        }
    }

    queryNextFolder();
}


// --------------------------------------------------
// Upload scan results
// --------------------------------------------------

uploadNextChunk()
{
    if (!gUploading)
        return;

    integer total = llGetListLength(gFolderPaths);

    if (gUploadIndex >= total)
    {
        sendPOST(
            "scan_finish",
            makeJSON([
                "action", "scan_finish",
                "token", (string)gPairToken
            ])
        );

        return;
    }

    integer endIndex =
        gUploadIndex + gChunkSize - 1;

    if (endIndex >= total)
        endIndex = total - 1;

    list chunk = llList2List(
        gFolderPaths,
        gUploadIndex,
        endIndex
    );

    string body = makeJSON([
        "action", "sync_chunk",
        "token", (string)gPairToken
    ]);

    body = llJsonSetValue(
        body,
        ["paths"],
        llList2Json(JSON_ARRAY, chunk)
    );

    gUploadIndex = endIndex + 1;

    sendPOST("sync_chunk", body);
}


// --------------------------------------------------
// Website commands
// --------------------------------------------------

executeWebsiteCommand(
    string commandId,
    string action,
    string relativePath,
    string outfitName
)
{
    if (action == "strip_all")
    {
        // Restrict removal to the configured Closety root.
        llOwnerSay(
            "@detachall:"
            + rootPath()
            + "=force"
        );

        sendCommandResult(
            commandId,
            TRUE,
            "Closety strip command sent."
        );

        return;
    }

    if (!validRelativePath(relativePath))
    {
        sendCommandResult(
            commandId,
            FALSE,
            "Invalid outfit folder path."
        );

        return;
    }

    string target = fullRLVPath(relativePath);

    if (action == "wear")
    {
        llOwnerSay(
            "@attachallover:"
            + target
            + "=force"
        );

        sendCommandResult(
            commandId,
            TRUE,
            "Wear command sent for " + outfitName
        );

        return;
    }

    if (action == "remove")
    {
        llOwnerSay(
            "@detachall:"
            + target
            + "=force"
        );

        sendCommandResult(
            commandId,
            TRUE,
            "Remove command sent for " + outfitName
        );

        return;
    }

    sendCommandResult(
        commandId,
        FALSE,
        "Unsupported command."
    );
}

handleNextCommandResponse(string body)
{
    gCommandPollInFlight = FALSE;

    string commandId = llJsonGetValue(
        body,
        ["command", "id"]
    );

    if (
        commandId == JSON_INVALID ||
        commandId == JSON_NULL ||
        commandId == ""
    )
    {
        return;
    }

    string action = llJsonGetValue(
        body,
        ["command", "action"]
    );

    string path = llJsonGetValue(
        body,
        ["command", "path"]
    );

    string outfitName = llJsonGetValue(
        body,
        ["command", "outfitName"]
    );

    executeWebsiteCommand(
        commandId,
        action,
        path,
        outfitName
    );
}


// --------------------------------------------------
// Worn-state discovery
// --------------------------------------------------

startWornStateScan()
{
    if (
        !gPaired ||
        gScanning ||
        gUploading ||
        gWornQueryInFlight
    )
    {
        return;
    }

    gOutfitCandidates = [];
    gWornOutfits = [];
    gWornQueryIndex = 0;

    integer i;
    integer j;

    integer count = llGetListLength(
        gFolderPaths
    );

    // Preserve the existing behaviour:
    // only leaf folders are considered outfit candidates.
    for (i = 0; i < count; ++i)
    {
        string path = llList2String(
            gFolderPaths,
            i
        );

        integer hasChild = FALSE;

        for (j = 0; j < count; ++j)
        {
            string other = llList2String(
                gFolderPaths,
                j
            );

            if (
                other != path &&
                llSubStringIndex(
                    other,
                    path + "/"
                ) == 0
            )
            {
                hasChild = TRUE;
                jump child_check_done;
            }
        }

@child_check_done;

        if (!hasChild)
            gOutfitCandidates += [path];
    }

    if (llGetListLength(gOutfitCandidates) == 0)
    {
        sendPOST(
            "worn_state",
            makeJSON([
                "action", "worn_state",
                "token", (string)gPairToken,
                "wornOutfits", llList2Json(
                    JSON_ARRAY,
                    []
                )
            ])
        );

        return;
    }

    gWornQueryInFlight = TRUE;
    queryNextWornFolder();
}

queryNextWornFolder()
{
    if (!gWornQueryInFlight)
        return;

    if (
        gWornQueryIndex >=
        llGetListLength(gOutfitCandidates)
    )
    {
        string body = makeJSON([
            "action", "worn_state",
            "token", (string)gPairToken
        ]);

        body = llJsonSetValue(
            body,
            ["wornOutfits"],
            llList2Json(
                JSON_ARRAY,
                gWornOutfits
            )
        );

        gWornQueryInFlight = FALSE;

        sendPOST("worn_state", body);

        return;
    }

    string relativePath = llList2String(
        gOutfitCandidates,
        gWornQueryIndex
    );

    // Convert website-relative path back to RLV path.
    gCurrentFolder = fullRLVPath(relativePath);

    gWaitingForRLV = TRUE;
    gRLVDeadline = llGetUnixTime() + 8;

    llOwnerSay(
        "@getinvworn:"
        + gCurrentFolder
        + "="
        + (string)gRLVChannel
    );
}

handleWornFolderResponse(string message)
{
    if (
        !gWornQueryInFlight ||
        !gWaitingForRLV
    )
    {
        return;
    }

    gWaitingForRLV = FALSE;

    // Response begins with |dd for the queried folder.
    integer pipeAt = llSubStringIndex(
        message,
        "|"
    );

    if (
        pipeAt >= 0 &&
        llStringLength(message) > pipeAt + 2
    )
    {
        string digits = llGetSubString(
            message,
            pipeAt + 1,
            pipeAt + 2
        );

        integer folderStatus = (integer)
            llGetSubString(digits, 0, 0);

        // 2 = some items worn; 3 = all items worn.
        if (
            folderStatus == 2 ||
            folderStatus == 3
        )
        {
            string relativePath = llList2String(
                gOutfitCandidates,
                gWornQueryIndex
            );

            gWornOutfits += [relativePath];
        }
    }

    ++gWornQueryIndex;
    queryNextWornFolder();
}


// --------------------------------------------------
// Events
// --------------------------------------------------

default
{
    state_entry()
    {
        gAvatar = llGetOwner();

        gDialogChannel = -(
            100000 + (integer)llFrand(900000.0)
        );

        // RLV inventory replies use a non-zero channel.
        // Positive channels also support longer replies.
        gRLVChannel =
            1000000 + (integer)llFrand(9000000.0);

        gDialogListen = llListen(
            gDialogChannel,
            "",
            gAvatar,
            ""
        );

        gRLVListen = llListen(
            gRLVChannel,
            "",
            NULL_KEY,
            ""
        );

        readConfiguration();

        llSetTimerEvent(1.0);
    }

    on_rez(integer startParameter)
    {
        llResetScript();
    }

    changed(integer change)
    {
        if (change & CHANGED_OWNER)
        {
            llResetScript();
        }

        if (change & CHANGED_INVENTORY)
        {
            if (!gConfigReading)
                readConfiguration();
        }
    }

    dataserver(key queryId, string data)
    {
        if (queryId != gNotecardRequest)
            return;

        if (data == EOF)
        {
            gConfigReading = FALSE;

            if (WEBSITE_URL == "")
            {
                llOwnerSay(
                    "Closety: add WEBSITE_URL to "
                    + CONFIG_CARD + "."
                );
            }
            else
            {
                llOwnerSay(
                    "Closety ready. Touch the HUD for "
                    + "CONNECT, SCAN and HELP."
                );
            }

            return;
        }

        processConfigLine(data);

        ++gConfigLine;

        gNotecardRequest = llGetNotecardLine(
            CONFIG_CARD,
            gConfigLine
        );
    }

    touch_start(integer totalNumber)
    {
        integer i;

        for (i = 0; i < totalNumber; ++i)
        {
            if (llDetectedKey(i) == gAvatar)
                showMenu();
        }
    }

    listen(
        integer channel,
        string name,
        key id,
        string message
    )
    {
        if (
            channel == gDialogChannel &&
            id != gAvatar
        )
        {
            return;
        }

        if (channel == gDialogChannel)
        {
            if (message == "CONNECT")
            {
                startPairing();
            }
            else if (message == "SCAN")
            {
                startScan();
            }
            else if (message == "HELP")
            {
                showHelp();
            }

            return;
        }

        if (channel == gRLVChannel)
        {
            if (gScanning && gWaitingForRLV)
            {
                handleFolderResponse(message);
            }
            else if (
                gWornQueryInFlight &&
                gWaitingForRLV
            )
            {
                handleWornFolderResponse(message);
            }
        }
    }

    http_response(
        key requestId,
        integer status,
        list metadata,
        string body
    )
    {
        integer index = llListFindList(
            gHTTPIds,
            [requestId]
        );

        if (index == -1)
            return;

        string action = llList2String(
            gHTTPActions,
            index
        );

        gHTTPIds = llDeleteSubList(
            gHTTPIds,
            index,
            index
        );

        gHTTPActions = llDeleteSubList(
            gHTTPActions,
            index,
            index
        );

        if (status < 200 || status >= 300)
        {
            if (action == "next_command")
                gCommandPollInFlight = FALSE;

            if (action == "pair")
                gPaired = FALSE;

            if (
                action == "sync_chunk" ||
                action == "scan_start" ||
                action == "scan_finish"
            )
            {
                gScanning = FALSE;
                gUploading = FALSE;
            }

            llOwnerSay(
                "Closety server error: HTTP "
                + (string)status
                + ". Check the Netlify function logs."
            );

            return;
        }

        if (action == "pair")
        {
            gPaired = TRUE;

            llOwnerSay(
                "Closety: HUD paired successfully."
            );

            string url =
                trimSlash(WEBSITE_URL)
                + "/?token="
                + llEscapeURL((string)gPairToken);

            llLoadURL(
                gAvatar,
                "Open your paired Closety wardrobe",
                url
            );
        }
        else if (action == "scan_start")
        {
            queryNextFolder();
        }
        else if (action == "sync_chunk")
        {
            uploadNextChunk();
        }
        else if (action == "scan_finish")
        {
            gUploading = FALSE;
            gScanning = FALSE;

            if (gScanHadTimeout)
            {
                llOwnerSay(
                    "Closety: scan uploaded, but one or more "
                    + "folders timed out. Some folders may be missing."
                );
            }
            else if (llGetListLength(gFolderPaths) == 0)
            {
                llOwnerSay(
                    "Closety: scan finished but found no subfolders "
                    + "inside #RLV/" + INVENTORY_ROOT + "."
                );
            }
            else
            {
                llOwnerSay(
                    "Closety: scan uploaded. Found "
                    + (string)llGetListLength(gFolderPaths)
                    + " folders. Click Refresh on the website."
                );
            }

            startWornStateScan();
        }
        else if (action == "next_command")
        {
            handleNextCommandResponse(body);
        }
        else if (action == "worn_state")
        {
            llOwnerSay(
                "Closety: worn-state report sent."
            );
        }
    }

    timer()
    {
        integer now = llGetUnixTime();

        if (
            gWaitingForRLV &&
            now >= gRLVDeadline
        )
        {
            gWaitingForRLV = FALSE;

            if (gScanning)
            {
                if (gCurrentFolder == rootPath())
                {
                    // Do not upload a misleading empty scan
                    // if the initial RLV request fails.
                    gScanning = FALSE;
                    gUploading = FALSE;
                    gFolderQueue = [];
                    gFolderPaths = [];

                    llOwnerSay(
                        "Closety ERROR: no RLV reply for #RLV/"
                        + INVENTORY_ROOT + ".\n"
                        + "Check that RLVa/RLV is enabled and "
                        + "that the folder exists inside #RLV.\n"
                        + "No scan results were uploaded."
                    );
                }
                else
                {
                    gScanHadTimeout = TRUE;

                    llOwnerSay(
                        "Closety WARNING: no RLV reply for "
                        + gCurrentFolder
                        + ". Skipping this folder."
                    );

                    queryNextFolder();
                }
            }
            else if (gWornQueryInFlight)
            {
                ++gWornQueryIndex;
                queryNextWornFolder();
            }
        }

        if (
            gPaired &&
            !gScanning &&
            !gUploading &&
            !gWornQueryInFlight &&
            !gCommandPollInFlight &&
            now >= gNextCommandPoll
        )
        {
            beginCommandPoll();
        }
    }
}
