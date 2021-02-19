const express = require("express");
const { MongoClient } = require("mongodb");
const csvtojson = require("csvtojson");

const DB_URL = process.env.DB_URL || "mongodb://localhost:27017/"
const DB_DB = process.env.DB_DB || "plz_geosearch"
const INPUT_DATA = process.env.INPUT_DATA || "data_setup/data.csv";
const MAX_DIST_KM = process.env.MAX_DIST_KM || 200
const FORCE_RECREATE = process.env.FORCE_RECREATE || false


/**
 * Calculates lat-lon distance between two objects
 * @param  {Object} o1 First Object (with lat lon attribute)
 * @param  {Object} o2 Second Object (with lat lon attribute)
 * @return {Float}    Distance between the two objects in km
 */
function calcDist(o1, o2)
{
  let mid_lat = (o1.lat + o2.lat) / 2;
  let d_lat = o2.lat - o1.lat;
  let d_lon = o2.lon - o1.lon;
  d_lon *= Math.cos(Math.PI * mid_lat / 180);
  // 1 deg ^= 60 NM // 1 NM = 1.852 KM
  // 60 * 1.852 = 111.12
  let dist = Math.sqrt(d_lat*d_lat + d_lon*d_lon) * 111.12;
  return Math.round(dist);
}

/**
 * Calculates distances from plzData and puts element by element into the Database
 * @param  {mongodb.Collation} coll    Collation to insert the objects in
 * @param  {Array} plzData PLZ Object Data
 */
async function calcAndUpdateDistances(coll, plzData)
{
  //remove unessecary columns
  for (let i=0; i < plzData.length; i++)
  {
    delete plzData[i].id;
    delete plzData[i].loc_id
    plzData[i].lat = Number.parseFloat(plzData[i].lat);
    plzData[i].lon = Number.parseFloat(plzData[i].lon);
    plzData[i].nearest = [];
  }

  //calculate distances - 2 iterations
  for (let i=0; i < plzData.length; i++)
  {
    for (let j=0; j < plzData.length; j++)
    {
      if (i == j) continue;
      let dist = calcDist(plzData[i], plzData[j]);
      if (dist <= MAX_DIST_KM) {
        let nrdata = {
          zip_code: plzData[j].zip_code,
          dist: dist
        };
        plzData[i].nearest.push(nrdata);
      }
    }

    //sort nearest
    plzData[i].nearest.sort((e1, e2) => {
      return e1.dist - e2.dist;
    });

    //filter distinct
    plzData[i].nearest = plzData[i].nearest.filter((v,i,a)=>a.findIndex(t=>(t.zip_code === v.zip_code))===i);

    //debug
    if (i % 100 == 0) {
      let percent = i / plzData.length * 100;
      console.log(i + ": " + Math.round(percent) + "%");
      //console.log(plzData[i]);
    }

    //db insert and memory cleanup
    await coll.insertOne(plzData[i]);
    plzData[i].nearest = [];
  }
}

/**
 * Init function, checks and initializes database
 */
async function init() {
  const client = MongoClient(DB_URL, { useUnifiedTopology: true}, { useNewUrlParser: true }, { connectTimeoutMS: 120000 }, { keepAlive: 1});

  try {
    await client.connect();

    let db = client.db(DB_DB);
    let coll = db.collection("zip");
    let count = await coll.countDocuments();

    if (count <= 0 || FORCE_RECREATE) {
      if (FORCE_RECREATE) {
        console.log("Recreating the datasets");
      } else {
        console.log("No Datasets");
      }
      await setupDatabase(coll);
      await coll.createIndex({zip_code: 1, name: "text"});
    } else {
      console.log("Found " + count + " entities");
    }


  } finally {
    await client.close();
  }
}

/**
 * Truncates the database collation, parses csv data and calls calculate function
 * @param  {mongodb.Collation} coll Collation for inserting data
 */
async function setupDatabase(coll) {
  console.log("Setting up database");

  await coll.drop((error, result) => {});

  await csvtojson()
  .fromFile(INPUT_DATA)
  .then(async csvData => {
    console.log("Parsed " + csvData.length + " entities")
    await calcAndUpdateDistances(coll, csvData);

  });

  let count = await coll.countDocuments();
  console.log("Inserted " + count + " entities");
}

/**
 * Main app function
 */
async function run() {
  await init();

  var app = express();

  app.get('/:zip/:rng', async (req, res) => {
    if (!req.params.zip || !req.params.rng) {
      res.status(400).send('Bad Request');
      return;
    }

    const client = MongoClient(DB_URL, { useUnifiedTopology: true}, { useNewUrlParser: true }, { connectTimeoutMS: 3000 }, { keepAlive: 1});

    try {
      await client.connect();
      let db = client.db(DB_DB);
      let coll = db.collection("zip");
      let query = { zip_code: req.params.zip };
      var zip = await coll.findOne(query, { projection: {_id: 0}});
      if (zip) {
        zip.nearest = zip.nearest.filter(e => e.dist <= req.params.rng);
      }
      //console.log(plz);
      res.json(zip);
    } finally {
      await client.close();
    }
  });

  app.get('/:search?', async (req, res) => {
    if (!req.params.search) {
      res.status(400).send('Bad Request');
      return;
    }

    const client = MongoClient(DB_URL, { useUnifiedTopology: true}, { useNewUrlParser: true }, { connectTimeoutMS: 3000 }, { keepAlive: 1});
    try {
      await client.connect();
      let db = client.db(DB_DB);
      let coll = db.collection("zip");
      let query = { $text: { $search: req.params.search } };
      
      var zip = await coll.find(
        query,
        {score: { $meta: "textScore" }, projection: {_id: 0, nearest: 0}})
        .sort( { score: { $meta: "textScore" } } )
        .limit(5)
        .toArray();

      console.log(zip);
      res.json(zip);
    } finally {
      await client.close();
    }

  });

  app.listen(8080, () => {
   console.log("Server running on port 8080");
  });

}


run();
