I want an app for doing organizational tasks on email.

I use Spark Desktop for email and I like it for normal email activities, but
it's a pain in the ass for organzing folders. I like the old-school heirarchy of
directories approach and modern email clients seem to push other options.


## Tasks

- Updating folder structure
  - add folders
  - delete folders
  - move everything in subfolders up to parent folder and delete subfolders

- Delete emails

## UX

- Heirarchical folder list (like in a file browser, or what used to be normal in
  email clients until the UX people decided to cater to normal folks)
  - Open/close subfolders functionality

- option to show only folders with no emails from past n months.

- List all emails (normal stuff like subject, date, from, to)

- Click on email displays content (could be just the text, goal is to get a gist
  of the email as I'm organizing, not proper display). It would be nice if
content could just be displayed underneath email (like an arrow that opens first
four lines when clicked, full content when double-clicked; closes when clicked
againt

- Within folder, select emails (checkboxes) to do batch actions

- Confirm batch actions but don't be whiny about it :)

- Fewest clicks possible to do tasks listed above. Again, similar to a file
  browser. In particular, to add a subfolder, I want to be able to
click/right-click the parent folder or icon by it, maybe select "Add folder"
then give the name.

## Requirements

Needs to be able to handle multiple accounts, including moving between accounts.

Need to be able to mark "Done with this folder" and store that somewhere
timestamped (so I can later go back to anything with a timestamp before x)

IMAP accounts only

## Data storage

Sqlite db or flat file should be fine. Local mysql would be fine too.

- account info
  - password can be saved. App is only for me and will be run locally only.
- folder data
  - when I last marked as "done looking at"
  - maybe some cache data, like date range of emails in folder and number--not
    sure if this is useful
