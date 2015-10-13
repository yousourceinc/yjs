/* global Y */
/* eslint-env browser, jasmine */

/*
  This is just a compilation of functions that help to test this library!
*/

// When testing, you store everything on the global object. We call it g
var g
if (typeof global !== 'undefined') {
  g = global
} else if (typeof window !== 'undefined') {
  g = window
} else {
  throw new Error('No global object?')
}
g.g = g

g.YConcurrency_TestingMode = true

jasmine.DEFAULT_TIMEOUT_INTERVAL = 2000

g.describeManyTimes = function describeManyTimes (times, name, f) {
  for (var i = 0; i < times; i++) {
    describe(name, f)
  }
}

/*
  Wait for a specified amount of time (in ms). defaults to 5ms
*/
function wait (t) {
  if (t == null) {
    t = 10
  }
  return new Promise(function (resolve) {
    setTimeout(function () {
      resolve()
    }, t)
  })
}
g.wait = wait

/*
  returns a random element of o.
  works on Object, and Array
*/
function getRandom (o) {
  if (o instanceof Array) {
    return o[Math.floor(Math.random() * o.length)]
  } else if (o.constructor === Object) {
    var ks = []
    for (var key in o) {
      ks.push(key)
    }
    return o[getRandom(ks)]
  }
}
g.getRandom = getRandom

function getRandomNumber (n) {
  if (n == null) {
    n = 9999
  }
  return Math.floor(Math.random() * n)
}
g.getRandomNumber = getRandomNumber

function * applyTransactions (relAmount, numberOfTransactions, objects, users, transactions) {
  function randomTransaction (root) {
    var f = getRandom(transactions)
    f(root)
  }
  for (var i = 0; i < numberOfTransactions * relAmount + 1; i++) {
    var r = Math.random()
    if (r >= 0.5) {
      // 50% chance to flush
      users[0].connector.flushOne() // flushes for some user.. (not necessarily 0)
    } else if (r >= 0.05) {
      // 45% chance to create operation
      randomTransaction(getRandom(objects))
    } else {
      // 5% chance to disconnect/reconnect
      var u = getRandom(users)
      if (u.connector.isDisconnected()) {
        yield u.reconnect()
      } else {
        yield u.disconnect()
      }
    }
    yield wait()
  }
}

g.applyRandomTransactionsAllRejoinNoGC = async(function * applyRandomTransactions (users, objects, transactions, numberOfTransactions) {
  yield* applyTransactions(1, numberOfTransactions, objects, users, transactions)
  yield users[0].connector.flushAll()
  yield wait()
  for (var u in users) {
    yield users[u].reconnect()
  }
  yield wait(100)
  yield users[0].connector.flushAll()
  yield g.garbageCollectAllUsers(users)
})

g.applyRandomTransactionsWithGC = async(function * applyRandomTransactions (users, objects, transactions, numberOfTransactions) {
  yield* applyTransactions(1, numberOfTransactions, objects, users.slice(1), transactions)
  yield users[0].connector.flushAll()
  yield g.garbageCollectAllUsers(users)
  yield wait(100)
  for (var u in users) {
    // TODO: here, we enforce that two users never sync at the same time with u[0]
    //       enforce that in the connector itself!
    yield users[u].reconnect()
  }
  yield wait(100)
  yield users[0].connector.flushAll()
  yield wait(100)
  yield g.garbageCollectAllUsers(users)
})

g.garbageCollectAllUsers = async(function * garbageCollectAllUsers (users) {
  // gc two times because of the two gc phases (really collect everything)
  yield wait(100)
  for (var i in users) {
    yield users[i].db.garbageCollect()
    yield users[i].db.garbageCollect()
  }
  yield wait(100)
})

g.compareAllUsers = async(function * compareAllUsers (users) {
  var s1, s2 // state sets
  var ds1, ds2 // delete sets
  var allDels1, allDels2 // all deletions
  var db1 = [] // operation store of user1

  // t1 and t2 basically do the same. They define t[1,2], ds[1,2], and allDels[1,2]
  function * t1 () {
    s1 = yield* this.getStateSet()
    ds1 = yield* this.getDeleteSet()
    allDels1 = []
    yield* this.ds.iterate(this, null, null, function * (d) {
      allDels1.push(d)
    })
  }
  function * t2 () {
    s2 = yield* this.getStateSet()
    ds2 = yield* this.getDeleteSet()
    allDels2 = []
    yield* this.ds.iterate(this, null, null, function * (d) {
      allDels2.push(d)
    })
  }
  yield users[0].connector.flushAll()
  yield g.garbageCollectAllUsers(users)

  for (var uid = 0; uid < users.length; uid++) {
    var u = users[uid]
    u.db.requestTransaction(function * () {
      // compare deleted ops against deleteStore
      yield* this.os.iterate(this, null, null, function * (o) {
        if (o.deleted === true) {
          expect(yield* this.isDeleted(o.id)).toBeTruthy()
        }
      })
      // compare deleteStore against deleted ops
      var ds = []
      yield* this.ds.iterate(this, null, null, function * (d) {
        ds.push(d)
      })
      for (var j in ds) {
        var d = ds[j]
        for (var i = 0; i < d.len; i++) {
          var o = yield* this.getOperation([d.id[0], d.id[1] + i])
          // gc'd or deleted
          if (d.gc) {
            expect(o).toBeUndefined()
          } else {
            expect(o.deleted).toBeTruthy()
          }
        }
      }
    })
    // compare allDels tree
    yield wait()
    if (s1 == null) {
      u.db.requestTransaction(function * () {
        yield* t1.call(this)
        yield* this.os.iterate(this, null, null, function * (o) {
          o = Y.utils.copyObject(o)
          delete o.origin
          db1.push(o)
        })
      })
      yield wait()
    } else {
      // TODO: make requestTransaction return a promise..
      u.db.requestTransaction(function * () {
        yield* t2.call(this)
        expect(s1).toEqual(s2)
        expect(allDels1).toEqual(allDels2) // inner structure
        expect(ds1).toEqual(ds2) // exported structure
        var count = 0
        yield* this.os.iterate(this, null, null, function * (o) {
          o = Y.utils.copyObject(o)
          delete o.origin
          expect(db1[count++]).toEqual(o)
        })
      })
      yield wait()
    }
  }
})

g.createUsers = async(function * createUsers (self, numberOfUsers) {
  if (Y.utils.globalRoom.users[0] != null) {
    yield Y.utils.globalRoom.users[0].flushAll()
  }
  // destroy old users
  for (var u in Y.utils.globalRoom.users) {
    Y.utils.globalRoom.users[u].y.destroy()
  }
  self.users = null

  var promises = []
  for (var i = 0; i < numberOfUsers; i++) {
    promises.push(Y({
      db: {
        name: 'Memory',
        gcTimeout: -1
      },
      connector: {
        name: 'Test',
        debug: false
      }
    }))
  }
  self.users = yield Promise.all(promises)
  return self.users
})

/*
  Until async/await arrives in js, we use this function to wait for promises
  by yielding them.
*/
function async (makeGenerator) {
  return function (arg) {
    var generator = makeGenerator.apply(this, arguments)

    function handle (result) {
      if (result.done) return Promise.resolve(result.value)

      return Promise.resolve(result.value).then(function (res) {
        return handle(generator.next(res))
      }, function (err) {
        return handle(generator.throw(err))
      })
    }
    try {
      return handle(generator.next())
    } catch (ex) {
      generator.throw(ex)
      // return Promise.reject(ex)
    }
  }
}
g.async = async

var logUsers = async(function * logUsers (self) {
  if (self.constructor === Array) {
    self = {users: self}
  }
  console.log('User 1: ', self.users[0].connector.userId, "=============================================") // eslint-disable-line
  yield self.users[0].db.logTable() // eslint-disable-line
  console.log('User 2: ', self.users[1].connector.userId, "=============================================") // eslint-disable-line
  yield self.users[1].db.logTable() // eslint-disable-line
  console.log('User 3: ', self.users[2].connector.userId, "=============================================") // eslint-disable-line
  yield self.users[2].db.logTable() // eslint-disable-line
})

g.logUsers = logUsers
