// import slug from 'unicode-slug'
import golos from 'golos-js'
import golos_auth from '../../node_modules/golos-js/lib/auth'

import store from 'store'
import auth from '../auth'
import { ChainConfig, PrivateKey, TransactionBuilder } from 'esteem-lib'
import { User, Comment, Post, UserBlockChain, BlockChain } from '../services'
const slugify = require('unicode-slug')

export default {
  // TODO Полностью зарефакторить все методы работы с блокчейном , все проверки блокчейна в 1 месте
  wif: '',
  current: {},
  bc_list: [],
  blockchains: {},
  app_tag: process.env.NODE_ENV === 'production' ? 'mapala' : 'testing',
  // TODO разветвить постинг в зависимости от NODE_ENV

  init (store = '') {
    ChainConfig.expire_in_secs = 30
    BlockChain.query().then(res => {
      for (const bc of res.data) {
        this.blockchains[bc.name] = bc
      }
      this.setBlockchain(undefined, store.state)
    })
  },

  getUser (username = null) {
    return new Promise((resolve, reject) => {
      username = username || this.current.blockchain_username
      golos.api.getAccounts([username], (err, result) => {
        err ? reject(err) : resolve(result[0])
      })
    })
  },

  getPermlink (text) {
    return slugify(text)
  },

  checkValidKey (context, reject) {
    if (!this.current.key_valid) {
      throw new Error(context.$t('add_key_err', { bc: this.current.name }))
    }
  },

  async signTr (tx) {
    tx = Object.assign(tx, await golos.broadcast._prepareTransaction({})).toObject()
    return golos_auth.signTransaction(tx, {posting: this.current.wif})
  },

  async postExists (author, permlink) {
    const data = await golos.api.getContent(author, permlink)

    return !!data.id
  },

  async createPost (context, post) {
    post.permlink = this.getPermlink(post.title)

    if (await this.postExists(this.current.blockchain_username, post.permlink)) {
      throw new Error('Post with this title already exists')
    }

    return await this.updatePost(context, post)
  },

  async updatePost (context, post) {
    this.checkValidKey(context)
    const tr = new TransactionBuilder()
    post.permlink = this.getPermlink(post.title)
    tr.add_type_operation('comment', {
      parent_author: '',
      parent_permlink: this.app_tag,
      author: this.current.blockchain_username,
      permlink: post.permlink,
      title: post.title,
      body: post.body,
      json_metadata: this.getJsonMeta(post.meta)
    })
    const signedTr = await this.signTr(tr)
    try {
      return await Post.save({ tx: signedTr, blockchain: this.current.name })
    } catch (err) {
      throw new Error(err.response.data)
    }
  },

  createComment (context, comm) {
    return new Promise((resolve, reject) => {
      this.checkValidKey(context)

      const tr = new TransactionBuilder()
      tr.add_type_operation('comment', {
        parent_author: comm.parentAuthor,
        parent_permlink: comm.parentPermlink,
        author: this.current.blockchain_username,
        permlink: comm.permlink.replace('.', '-'),
        title: '',
        body: comm.body,
        json_metadata: this.getJsonMeta()
      })

      this.signTr(tr).then(tr => {
        Comment.save({ tx: tr, blockchain: this.current.name })
          .then(res => resolve(res))
          .catch(err => reject(err.response.data))
      }).catch(err => reject(err))
    })
  },

  vote (page) {
    return new Promise((resolve, reject) => {
      golos.broadcast.vote(
        this.current.wif, this.current.blockchain_username, page.author.bc_username, page.permlink, 10000, function (err, result) {
          if (err) {
            const message = err.cause.message
            if (message.includes('You have already voted in a similar way')) {
              reject('You have already voted in a similar way')
            } else if (message.includes('Cannot vote again on a comment after payout')) {
              reject('Cannot vote again on a comment after payout')
            } else {
              reject(err)
            }
          } else {
            resolve(result)
          }
        })
    })
  },

  getJsonMeta (meta = {}) {
    meta.app = 'mapala/1.0'
    meta.format = 'html'

    if (meta.tags === undefined) {
      meta.tags = [this.app_tag]
    } else if (!meta.tags.includes(this.app_tag)) {
      meta.tags.unshift(this.app_tag)
    }
    return JSON.stringify(meta)
  },

  setBlockchain (blockchain, state) {
    // HACK: На данный момент решено менять блокчейн по локали:
    // en -> steemil, ru -> golos

    if (typeof blockchain === 'undefined') {
      blockchain = state.locale === 'ru' ? 'golos' : 'steemit'
    }

    this.current = this.blockchains[blockchain]

    // steem-js conf
    golos.config.set('websocket', this.current.wss)
    golos.config.set('address_prefix', this.current.address_prefix)
    golos.config.set('chain_id', this.current.chain_id)
  },

  getPostingKey (blockchain, username) {
    if (blockchain === undefined) {
      return this.getPostingKey(this.current.name, username)
    }
    return store.get(`${blockchain}_${username}_posting_key`)
  },

  async initBlockchains (ctx = {}) {
    try {
      const username = ctx.$store.state.user.personal.username
      const { data } = await User.initialBlockchains({ username: username })

      const bc_list = []
      for (const bc of data) {

        if (bc.activated) {
          bc.wif = this.getPostingKey(bc.name, username)

          bc.blockchain_username = bc.blockchain_username.toLowerCase()

          try {
            PrivateKey.fromWif(bc.wif)
            bc.key_valid = true
          } catch (e) {
            // Невалидный ключ
            bc.wif = ''
            bc.key_valid = false
          }
        }

        bc_list.push(bc)
        this.blockchains[bc.name] = bc
      }
      this.bc_list = bc_list
      if (this.blockchains) {
        this.setBlockchain(undefined, ctx.$store.state)
      }
      // const { balance } = await this.getUser()
      // commit('user/wallet/SET_BALANCE', balance)
      // TODO SET_BALANCE GOLOS/GBG
    } catch (error) {
      console.error(error)
    }
  },

  getUsernameByKey (key, prefix = this.current.address_prefix) {
    return new Promise((resolve, reject) => {
      golos.config.set('address_prefix', prefix)
      golos.api.getKeyReferences([key], function (err, result) {
        err ? reject(err) : resolve(result[0][0])
      })
      if (this.current.address_prefix) {
        const curr_adress = this.current.address_prefix
        golos.config.set('address_prefix', curr_adress)
      }
    })
  },

  async setPostingKey (context, blockchain, username = '') {
    try {
      var res = await UserBlockChain.save({ blockchain: blockchain.name, wif: blockchain.wif })
    } catch (err) {
      throw new Error(err.response.status === 404 ? this.$t('has_not_user_with_key') : err.response.data)
    }

    store.set(`${blockchain.name}_${username || auth.user.username}_posting_key`, blockchain.wif)
    this.blockchains = []
    this.initBlockchains(context)

    return res
  },

  /**
   * check blockhcain Key
   * @param  {string} key   blockchain private key
   * @return {boolean}
   */
  checkPostingKey (key, prefix) {
    if (key && (prefix === 'GLS')) { return key.startsWith(prefix) }
  },
  /**
   * check GOLOS posting key
   * @param  {string} key   golos posting key
   * @return {boolean}
   */
  checkGolosKey () {
    var key = this.bc_list[0].wif
    return this.checkPostingKey(key, 'GLS')
  }
}
