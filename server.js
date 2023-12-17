const express = require("express")
const path = require("path")
const bodyParser = require("body-parser")
const {MongoClient, ServerApiVersion} = require("mongodb")
const fetch = require("node-fetch")
const { match } = require("assert")
require('dotenv').config() // process.env.VARIABLE_NAME

// SERVER SETUP ============================================================
let args = process.argv

if (args.length != 3) {
    process.stdout.write("Command syntax: server.js <port number>\n")
    process.exit(1)
}

let portNumber = args[2]

const app = express()

app.set("view engine", "ejs")
app.set("views", path.resolve(__dirname, "templates"))

app.use(bodyParser.urlencoded({extended: false}))

const od_url = "https://api.opendota.com/api"

app.use(express.static(__dirname + '/public'))

// Mongo Initialization ============================================
const connectionString = `mongodb+srv://${process.env.MONGO_DB_USERNAME}:${process.env.MONGO_DB_PASSWORD}@cluster0.ffiwirw.mongodb.net/?retryWrites=true&w=majority`
const client = new MongoClient(connectionString,  {
    serverApi: {
        version: ServerApiVersion.v1,
        strict: true,
        deprecationErrors: true,
    }
})
const db = client.db(process.env.MONGO_DB_NAME)
const collection = db.collection(process.env.MONGO_COLLECTION)

// Utility functions ===============================================
function get_rank_range_from_badge(badge) {
    switch (badge) { // not using breaks because every case returns
        case "Herald":
            return {min: 10, max: 15}
        case "Guardian":
            return {min: 20, max: 25}
        case "Crusader":
            return {min: 30, max: 35}
        case "Archon":
            return {min: 40, max: 45}
        case "Legend":
            return {min: 50, max: 55}
        case "Ancient":
            return {min: 60, max: 65}
        case "Divine":
            return {min: 70, max: 75}
        case "Immortal":
            return {min: 80, max: 85}
        default:
            console.error("Invalid badge provided")
            return null
    }
}

function get_gamemode_string(game_mode_id) {
    switch (game_mode_id) {
        case 1:
            return "Old School All Pick"
        case 2:
            return "Captain's Mode"
        case 3:
            return "Random Draft"
        case 4:
            return "Single Draft"
        case 5:
            return "All Random"
        case 6:
            return "Heroes for Beginners"
        case 7:
            return "Diretide"
        case 8:
            return "Reverse Captain's Mode"
        case 9:
            return "The Greeviling"
        case 10:
            return "Tutorial"
        case 11:
            return "Mid Only"
        case 12:
            return "Least Played"
        case 13:
            return "New Player Pool"
        case 22:
            return "All Pick"
        default:
            return "Unknown Game Mode"
    }
}

function min_2_digits(num) {
    let ret_string = String(num)
    if (ret_string.length == 1) {
        return "0" + ret_string
    } else if (ret_string.length < 1) {
        console.error("string was less than 1 len")
    }
    return ret_string
}

function get_match_promises(match_ids) {
    console.log("entered get_match_promises")
    return new Promise((resolve, reject) => {
        let match_promises = []
        let match_iter = match_ids.values()

        let intervalId;
    
        const add_next_match = () => {
            let next_id = match_iter.next()
            console.log("preparing to request match from od, match id:")
            console.log(next_id.value)
            if (!next_id.done) {
                console.log("sending request...")
                match_promises.push(fetch(od_url + "/matches/" + next_id.value))
            } else {
                console.log("done")
                clearInterval(intervalId)
                resolve(match_promises)
            }
        }
    
        intervalId = setInterval(add_next_match, 1000)
    }) 
}

function get_json_promises(od_responses) {
    let json_promises = []
    
    od_responses.forEach((od_response) => {
        json_promises.push(od_response.json())
    })

    return json_promises
}

async function save_matches(match_ids) {
    console.log("entered save_matches")
    let match_promises = await get_match_promises(match_ids)
    // use match ids to get matches

    let matches = []
    // wait for all of the match requests to come back
    let od_responses = await Promise.all(match_promises)

    let json_responses = get_json_promises(od_responses)

    let match_jsons = await Promise.all(json_responses)

    match_jsons.forEach((match_json) => {
        const minutes = min_2_digits(Math.floor(match_json.duration / 60))
        const seconds = min_2_digits(match_json.duration - (60 * minutes))

        const duration_string = minutes + ":" + seconds

        matches.push({
            match_id: match_json.match_id,
            winner: match_json.radiant_win ? "Radiant" : "Dire",
            duration: duration_string,
            lobby_type: match_json.lobby_type == 0 ? "Unranked" : "Ranked",
            game_mode: get_gamemode_string(match_json.game_mode)
        })
    })

    if (matches) {
        console.log("inserting matches into mongo")
        console.log("matches.length: " + matches.length)
        return collection.insertMany(matches).then((result) => {
            return result.insertedIds
        })
    } else {
        console.log("No matches found to save, match_ids:")
        console.log(match_ids)
        return null
    }

}

// GET endpoints ===================================================
app.get("/", (request, response) => {
    response.render("index")
})

app.get("/newmatches", (request, response) => {
    response.render("getNewMatchesForm")
})

app.get("/savedmatches", async (request, response) => {
    // get matches from mongo
    console.log("getting matches from mongo...")
    let matches = await collection.find({}).toArray()

    let matches_table = "<table><thead><tr><th>Match ID</th><th>Winning Team</th>" + 
                        "<th>Duration</th><th>Lobby Type</th><th>Game Mode</th></tr></thead><tbody>"

    matches.forEach((match) => {
        matches_table += `<tr>` + 
                         `<td>${match.match_id}</td>` +
                         `<td>${match.winner}</td>` +
                         `<td>${match.duration}</td>` +
                         `<td>${match.lobby_type}</td>` +
                         `<td>${match.game_mode}</td></tr>`;
    })

    locals = {
        matches_table: matches_table
    }

    response.render("showSavedMatches", locals)
})

// POST endpoints ==================================================
app.post("/newmatches", async (request, response) => {
    let {badge} = request.body

    const {min, max} = get_rank_range_from_badge(badge)
    
    let res = await fetch(od_url + `/publicMatches?min_rank=${min}`)
    let jason = await res.json()
    
    const matches = jason.map((match) => {
        const minutes = min_2_digits(Math.floor(match.duration / 60))
        const seconds = min_2_digits(match.duration - (60 * minutes))

        const duration_string = minutes + ":" + seconds

        const mode_string = get_gamemode_string(match.game_mode)

        return {
            match_id: match.match_id,
            winner: match.radiant_win ? "Radiant" : "Dire",
            duration: duration_string,
            lobby_type: match.lobby_type == 0 ? "Unranked" : "Ranked",
            game_mode: mode_string
        }
    })

    let matches_table = "<table><thead><tr><th>Match ID</th><th>Winning Team</th>" + 
                        "<th>Duration</th><th>Lobby Type</th><th>Game Mode</th></tr></thead><tbody>"

    matches.forEach((match) => {
        matches_table += `<tr>` + 
                         `<td>${match.match_id}</td>` +
                         `<td>${match.winner}</td>` +
                         `<td>${match.duration}</td>` +
                         `<td>${match.lobby_type}</td>` +
                         `<td>${match.game_mode}</td></tr>`;
    })

    locals = {
        matches_table: matches_table
    }

    response.render("showNewMatches", locals)
})

app.post("/savematches", async (request, response) => {
    console.log("Incoming request to save matches (listed below): ")
    const {match_list} = request.body

    const matches = match_list.split(/\s/)
    console.log(matches)

    save_matches(matches).then((mongo_ids) => {
        response.redirect("/savedmatches")
    })
})

app.listen(portNumber)